-- Invariante: ingresso operacional pertence a uma conta.
-- Excecao temporaria: owner null SOMENTE com intended_owner e Cadastro ainda sem user_id.
-- Claim materializa so por intended_owner_contact_id. Nunca holder/e-mail/CPF.
-- Checkout autenticado: owner = comprador, mesmo com titular terceiro.
-- Camada unica: trigger em registration_contacts.user_id cobre todo writer
-- (claim, ensure, import, reconcile). Reconcile chama a RPC no retry, quando
-- user_id ja estava igual e o trigger nao dispara. Claim nao chama a RPC de novo.
-- Nao executa backfill de linhas nesta migration.

begin;

alter table public.ticket_owner_history
  drop constraint if exists ticket_owner_history_reason_code_check;

alter table public.ticket_owner_history
  add constraint ticket_owner_history_reason_code_check
    check (reason_code = any (array[
      'registration_correction',
      'buyer_request',
      'holder_request',
      'third_party_ticket',
      'administrative_adjustment',
      'issuance_error',
      'system_error',
      'data_regularization',
      'other',
      'legacy_unclassified',
      'shared_email',
      'family_responsible',
      'account_correction',
      'administrative_transfer',
      'intended_owner_materialized'
    ]));

create or replace function public.materialize_intended_ticket_owners_for_contact(p_contact_id uuid, p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_actor uuid := auth.uid();
begin
  if p_contact_id is null or p_user_id is null then return 0; end if;
  if not exists (
    select 1
    from public.registration_contacts c
    join auth.users au on au.id = c.user_id
    where c.id = p_contact_id
      and c.user_id = p_user_id
  ) then
    return 0;
  end if;

  with owned as (
    update public.tickets t
    set owner_user_id = p_user_id
    where t.intended_owner_contact_id = p_contact_id
      and t.owner_user_id is null
      and t.status not in ('cancelled', 'canceled', 'void', 'voided')
    returning t.id, t.order_id, t.event_id, t.organization_id
  ), history as (
    insert into public.ticket_owner_history (
      ticket_id, order_id, event_id, organization_id, operation,
      previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
    )
    select owned.id, owned.order_id, owned.event_id, owned.organization_id,
      'owner_assigned', null, p_user_id, coalesce(v_actor, p_user_id),
      'intended_owner_materialized',
      'Materializacao inicial a partir do Cadastro pretendido apos vinculo de conta. Nao e transferencia.'
    from owned
    returning ticket_id
  )
  select count(*)::integer into v_count from history;
  return v_count;
end;
$$;

create or replace function public.trg_ticket_copy_intended_owner()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- intended_owner e destino de propriedade, nunca sinonimo de titular.
  if new.intended_owner_contact_id is null and new.order_item_id is not null then
    select oi.intended_owner_contact_id
      into new.intended_owner_contact_id
    from public.order_items oi
    where oi.id = new.order_item_id;
  end if;
  return new;
end;
$$;

create or replace function public.trg_initialize_ticket_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_holder public.participants%rowtype;
  v_registration_contact_id uuid;
  v_import_batch_ids uuid[] := array[]::uuid[];
  v_imported_by_user_ids uuid[] := array[]::uuid[];
  v_is_imported boolean := false;
begin
  select * into v_order from public.orders where id = new.order_id;
  if not found then raise exception 'Pedido do ingresso nao encontrado.'; end if;
  if new.organization_id is null then
    new.organization_id := v_order.organization_id;
  elsif new.organization_id is distinct from v_order.organization_id then
    raise exception 'Organizacao do ingresso diverge do pedido.';
  end if;

  if new.order_item_id is not null then
    select * into v_item from public.order_items where id = new.order_item_id;
  end if;
  if coalesce(v_item.participant_id, new.participant_id) is not null then
    select * into v_holder from public.participants where id = coalesce(v_item.participant_id, new.participant_id);
  end if;
  v_registration_contact_id := coalesce(v_item.registration_contact_id, v_holder.registration_contact_id);

  if new.intended_owner_contact_id is null then
    new.intended_owner_contact_id := v_item.intended_owner_contact_id;
  end if;

  -- Compra autenticada: o ingresso nasce do comprador. Titular nao define owner.
  if v_order.buyer_type = 'account' then
    if v_order.user_id is null or not exists (select 1 from auth.users where id = v_order.user_id) then
      raise exception 'Pedido de conta sem comprador autenticado valido.';
    end if;
    new.owner_user_id := v_order.user_id;
    return new;
  end if;

  if new.intended_owner_contact_id is null
     and v_order.buyer_type in ('administrative', 'imported_holder') then
    new.intended_owner_contact_id := v_registration_contact_id;
  end if;

  select coalesce(array_agg(distinct ib.id order by ib.id), array[]::uuid[]),
    coalesce(array_agg(distinct ib.imported_by order by ib.imported_by) filter (where ib.imported_by is not null), array[]::uuid[])
  into v_import_batch_ids, v_imported_by_user_ids
  from public.import_batches ib
  where ib.id = v_order.import_batch_id;

  v_is_imported := v_order.buyer_type = 'imported_holder' or v_order.import_batch_id is not null;

  if v_is_imported then
    new.owner_user_id := public.resolve_administrative_ticket_owner(new.organization_id, v_registration_contact_id);
    if new.owner_user_id is not null and new.owner_user_id = any (v_imported_by_user_ids) then
      new.owner_user_id := null;
    end if;
    return new;
  end if;

  if v_order.buyer_type = 'administrative' then
    new.owner_user_id := public.resolve_administrative_ticket_owner(new.organization_id, v_registration_contact_id);
    return new;
  end if;
  if new.owner_user_id is not null then return new; end if;
  raise exception 'Origem do pedido nao permite inicializar proprietario.';
end;
$$;

create or replace function public.trg_zz_ticket_ownership_invariant()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status in ('cancelled', 'canceled', 'void', 'voided') then
    return new;
  end if;
  if new.owner_user_id is null and new.intended_owner_contact_id is null then
    raise exception 'TICKET_OWNERSHIP_INCOMPLETE: ingresso operacional exige owner_user_id ou intended_owner_contact_id.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_zz_ticket_ownership_invariant on public.tickets;
create trigger trg_zz_ticket_ownership_invariant
before insert or update of owner_user_id, intended_owner_contact_id, status
on public.tickets
for each row execute function public.trg_zz_ticket_ownership_invariant();

create or replace function public.trg_materialize_tickets_when_contact_account_linked()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.user_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.user_id is not distinct from new.user_id then
    return new;
  end if;
  perform public.materialize_intended_ticket_owners_for_contact(new.id, new.user_id);
  return new;
end;
$$;

drop trigger if exists trg_materialize_tickets_when_contact_account_linked on public.registration_contacts;
create trigger trg_materialize_tickets_when_contact_account_linked
after insert or update of user_id
on public.registration_contacts
for each row execute function public.trg_materialize_tickets_when_contact_account_linked();

create or replace function public.reconcile_registration_contact_account(
  p_registration_contact_id uuid,
  p_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_ticket_count integer := 0;
  v_participant_already_linked boolean := false;
begin
  if p_registration_contact_id is null or p_user_id is null then
    raise exception 'Pessoa e conta sao obrigatorias.';
  end if;
  if v_actor is not null and v_actor <> p_user_id
     and not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao para reconciliar esta pessoa.';
  end if;
  if not exists(select 1 from auth.users as account_user where account_user.id = p_user_id) then
    raise exception 'Conta Auth inexistente.';
  end if;

  select contact.* into v_contact
  from public.registration_contacts as contact
  where contact.id = p_registration_contact_id
  for update;
  if not found then raise exception 'Pessoa nao encontrada.'; end if;
  if v_actor is not null and v_actor <> p_user_id
     and not public.user_can_access_organization(v_actor, v_contact.organization_id) then
    raise exception 'Pessoa fora da organizacao atual.';
  end if;
  if v_contact.user_id is not null and v_contact.user_id <> p_user_id then
    raise exception 'Pessoa ja vinculada a outra conta.';
  end if;
  if exists (
    select 1 from public.participants as conflicting
    where conflicting.registration_contact_id = v_contact.id
      and conflicting.user_id is not null
      and conflicting.user_id <> p_user_id
  ) then
    raise exception 'Participacao vinculada a outra conta.';
  end if;

  select exists (
    select 1 from public.participants as linked_participant
    where linked_participant.registration_contact_id = v_contact.id
      and linked_participant.user_id = p_user_id
  ) into v_participant_already_linked;

  if v_contact.user_id is null
     and public.registration_contact_has_protected_identity_rights(v_contact.id)
     and not public.registration_contact_invite_authorizes_user(v_contact.id, p_user_id, false)
     and not v_participant_already_linked then
    raise exception using errcode = 'P0001',
      message = 'REGISTRATION_CONTACT_REQUIRES_INVITE',
      detail = jsonb_build_object(
        'code', 'REGISTRATION_CONTACT_REQUIRES_INVITE',
        'message', 'Este cadastro exige convite/claim. UUID nao e autorizacao.'
      )::text;
  end if;

  update public.registration_contacts as linked_contact
  set user_id = p_user_id, updated_at = now()
  where linked_contact.id = v_contact.id
    and linked_contact.user_id is distinct from p_user_id;

  update public.customer_profiles as profile
  set full_name = v_contact.full_name, updated_at = now()
  where profile.user_id = p_user_id
    and nullif(trim(v_contact.full_name), '') is not null
    and (
      nullif(trim(profile.full_name), '') is null
      or lower(trim(profile.full_name)) = 'participante'
    );

  update public.participants as linked_participant
  set user_id = p_user_id, updated_at = now()
  where linked_participant.registration_contact_id = v_contact.id
    and linked_participant.organization_id = v_contact.organization_id
    and linked_participant.user_id is null;

  update public.sponsors as linked_sponsor
  set user_id = p_user_id, updated_at = now()
  where linked_sponsor.registration_contact_id = v_contact.id
    and linked_sponsor.user_id is null;

  v_ticket_count := public.materialize_intended_ticket_owners_for_contact(v_contact.id, p_user_id);

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'registration_contact_account_reconciled', 'registration_contacts', v_contact.id, null,
    jsonb_build_object(
      'organization_id', v_contact.organization_id,
      'user_id', p_user_id,
      'tickets_assigned', v_ticket_count,
      'actor_user_id', v_actor
    )
  );
  return v_ticket_count;
end;
$$;

create or replace function public.claim_registration_contact_account_invite(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_auth_email text;
  v_metadata_invite text;
  v_inv public.participant_account_invites%rowtype;
  v_contact public.registration_contacts%rowtype;
  v_authorized boolean := false;
  v_invite_updated uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select lower(trim(email)), raw_user_meta_data->>'participant_invite_id'
    into v_auth_email, v_metadata_invite
    from auth.users where id = v_actor;
  select * into v_inv from public.participant_account_invites
  where id = p_invite_id and registration_contact_id is not null
  for update;
  if not found then raise exception 'Convite invalido ou expirado.'; end if;

  select * into v_contact from public.registration_contacts
  where id = v_inv.registration_contact_id for update;
  if not found or v_contact.organization_id is distinct from v_inv.organization_id then
    raise exception 'Pessoa invalida para a organizacao do convite.';
  end if;

  if v_inv.status = 'claimed' then
    if v_inv.claimed_user_id is distinct from v_actor
      or v_contact.user_id is distinct from v_actor then
      raise exception 'Convite ja reivindicado por outra conta.';
    end if;
    -- user_id ja vinculado: o trigger nao dispara. Reconcile materializa pendencias.
    perform public.reconcile_registration_contact_account(v_contact.id, v_actor);
    return v_contact.id;
  end if;
  if v_inv.status <> 'pending' or v_inv.expires_at <= now() then
    raise exception 'Convite invalido ou expirado.';
  end if;
  if v_auth_email is distinct from lower(trim(v_inv.email)) then
    raise exception 'O convite nao pertence a esta conta.';
  end if;
  if nullif(trim(coalesce(v_contact.email, '')), '') is not null
     and lower(trim(v_contact.email)) is distinct from v_auth_email then
    raise exception 'O convite nao pertence a esta conta.';
  end if;
  if exists (
    select 1 from public.registration_contacts other
    where other.organization_id = v_contact.organization_id
      and other.user_id = v_actor
      and other.id is distinct from v_contact.id
  ) then
    raise exception 'O convite nao pertence a esta conta.';
  end if;
  if exists (
    select 1 from public.registration_contacts sibling
    where sibling.organization_id = v_contact.organization_id
      and sibling.id is distinct from v_contact.id
      and nullif(lower(trim(coalesce(sibling.email, ''))), '') is not null
      and lower(trim(sibling.email)) = v_auth_email
  ) then
    raise exception 'O convite nao pertence a esta conta.';
  end if;
  if exists (
    select 1 from public.customer_profiles cp
    where cp.user_id = v_actor
      and length(regexp_replace(coalesce(cp.cpf, ''), '\D', '', 'g')) = 11
      and regexp_replace(coalesce(v_contact.cpf, ''), '\D', '', 'g')
        is distinct from regexp_replace(coalesce(cp.cpf, ''), '\D', '', 'g')
  ) then
    raise exception 'O convite nao pertence a esta conta.';
  end if;
  v_authorized := coalesce(v_inv.auth_user_id = v_actor, false)
    or (
      v_inv.auth_user_id is null
      and v_metadata_invite is not null
      and v_metadata_invite = v_inv.id::text
    );
  if not v_authorized then
    raise exception 'O convite nao pertence a esta conta.';
  end if;
  if v_contact.user_id is not null and v_contact.user_id <> v_actor then
    raise exception 'Pessoa ja vinculada a outra conta.';
  end if;

  update public.registration_contacts
  set user_id = v_actor, updated_at = now()
  where id = v_contact.id;
  update public.participants
  set user_id = v_actor, updated_at = now()
  where registration_contact_id = v_contact.id
    and (user_id is null or user_id = v_actor);
  if exists (
    select 1 from public.participants
    where registration_contact_id = v_contact.id and user_id <> v_actor
  ) then
    raise exception 'Participacao da Pessoa vinculada a outra conta.';
  end if;

  update public.participant_account_invites
  set status = 'claimed',
      claimed_user_id = v_actor,
      auth_user_id = coalesce(auth_user_id, v_actor),
      claimed_at = now(),
      updated_at = now()
  where id = v_inv.id
    and (auth_user_id is null or auth_user_id = v_actor)
  returning id into v_invite_updated;
  if v_invite_updated is null then
    raise exception 'O convite nao pertence a esta conta.';
  end if;

  -- Vinculo de user_id acima ja disparou o trigger canonico.
  -- Reconcile cobre retry e writers que ligam a conta com user_id ja igual.
  perform public.reconcile_registration_contact_account(v_contact.id, v_actor);

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'registration_contact_account_invite_claimed', 'registration_contacts',
    v_contact.id, null,
    jsonb_build_object('invite_id', v_inv.id, 'user_id', v_actor,
      'organization_id', v_contact.organization_id)
  );
  return v_contact.id;
end;
$$;

create or replace function public.preview_intended_ticket_owner_materialization()
returns table(
  ticket_id uuid,
  display_code text,
  status text,
  holder_name text,
  intended_contact_id uuid,
  intended_contact_name text,
  intended_user_id uuid,
  owner_user_id uuid,
  eligibility_reason text,
  operational boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null
     and not public.current_user_has_permission('participants.edit_basic')
     and not public.current_user_has_permission('accounts.health.view') then
    raise exception 'Sem permissao para previsualizar materializacao de ownership.';
  end if;

  return query
  select
    t.id,
    case
      when o.display_number is not null and oi.item_position is not null
        then '#' || lpad(o.display_number::text, 6, '0') || '-' || lpad(oi.item_position::text, 2, '0')
      else null
    end,
    t.status,
    coalesce(oi.holder_full_name, p.full_name),
    c.id,
    c.full_name,
    c.user_id,
    t.owner_user_id,
    'owner_null_intended_contact_has_account'::text,
    (t.status not in ('cancelled', 'canceled', 'void', 'voided'))
  from public.tickets t
  join public.registration_contacts c on c.id = t.intended_owner_contact_id
  left join public.orders o on o.id = t.order_id
  left join public.order_items oi on oi.id = t.order_item_id
  left join public.participants p on p.id = t.participant_id
  where t.owner_user_id is null
    and t.intended_owner_contact_id is not null
    and c.user_id is not null
  order by (t.status not in ('cancelled', 'canceled', 'void', 'voided')) desc, o.display_number, oi.item_position;
end;
$$;

create or replace function public.reconcile_intended_ticket_owners_for_linked_contacts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_total integer := 0;
begin
  if auth.uid() is not null
     and not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao para reconciliar ownership pretendido.';
  end if;

  for v_row in
    select distinct c.id as contact_id, c.user_id
    from public.tickets t
    join public.registration_contacts c on c.id = t.intended_owner_contact_id
    where t.owner_user_id is null
      and t.status not in ('cancelled', 'canceled', 'void', 'voided')
      and c.user_id is not null
  loop
    v_total := v_total + public.materialize_intended_ticket_owners_for_contact(v_row.contact_id, v_row.user_id);
  end loop;
  return v_total;
end;
$$;

revoke all on function public.materialize_intended_ticket_owners_for_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function public.materialize_intended_ticket_owners_for_contact(uuid, uuid) to service_role;
revoke all on function public.reconcile_registration_contact_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reconcile_registration_contact_account(uuid, uuid) to service_role;
revoke all on function public.claim_registration_contact_account_invite(uuid) from public, anon, authenticated;
grant execute on function public.claim_registration_contact_account_invite(uuid) to authenticated, service_role;
revoke all on function public.preview_intended_ticket_owner_materialization() from public, anon;
grant execute on function public.preview_intended_ticket_owner_materialization() to authenticated, service_role;
revoke all on function public.reconcile_intended_ticket_owners_for_linked_contacts() from public, anon, authenticated;
grant execute on function public.reconcile_intended_ticket_owners_for_linked_contacts() to service_role;

commit;
