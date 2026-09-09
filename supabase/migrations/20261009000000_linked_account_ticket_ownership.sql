-- Ownership canônica: Pessoa com conta vinculada recebe tickets.owner_user_id.
-- Não usa e-mail. Não mistura comprador, titular e proprietário da conta.
-- Timestamp novo: 20261009000000 (não reutilizar 20261008000000).

begin;

-- Pessoa canônica → conta Auth. Nunca e-mail, nunca CPF inventado, nunca o operador.
create or replace function public.resolve_administrative_ticket_owner(
  p_organization_id uuid,
  p_registration_contact_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
begin
  if p_registration_contact_id is null or p_organization_id is null then
    return null;
  end if;

  select c.user_id into v_owner
  from public.registration_contacts c
  join auth.users au on au.id = c.user_id
  where c.id = p_registration_contact_id
    and c.organization_id = p_organization_id;

  if v_owner is null then
    return null;
  end if;

  if exists (
    select 1
    from public.participants p
    where p.registration_contact_id = p_registration_contact_id
      and p.organization_id = p_organization_id
      and p.user_id is not null
      and p.user_id is distinct from v_owner
  ) then
    raise exception 'ADMINISTRATIVE_TICKET_OWNER_AMBIGUOUS: cadastro possui mais de uma conta valida.';
  end if;

  return v_owner;
end;
$$;

revoke all on function public.resolve_administrative_ticket_owner(uuid, uuid) from public, anon, authenticated;
grant execute on function public.resolve_administrative_ticket_owner(uuid, uuid) to service_role;

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

  select coalesce(array_agg(distinct ib.id order by ib.id), array[]::uuid[]),
    coalesce(array_agg(distinct ib.imported_by order by ib.imported_by) filter (where ib.imported_by is not null), array[]::uuid[])
  into v_import_batch_ids, v_imported_by_user_ids
  from public.import_batches ib
  where ib.id = v_order.import_batch_id or exists (
    select 1 from public.participation_history ph
    where ph.import_batch_id = ib.id and ph.source = 'import'
      and ph.participant_id in (v_order.participant_id, coalesce(v_item.participant_id, new.participant_id))
  );
  v_is_imported := v_order.buyer_type = 'imported_holder' or cardinality(v_import_batch_ids) > 0;

  if v_is_imported then
    -- Conta da Pessoa canônica, nunca o importador e nunca e-mail compartilhado.
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
  if v_order.buyer_type = 'account' then
    if v_order.user_id is null or not exists (select 1 from auth.users where id = v_order.user_id) then
      raise exception 'Pedido de conta sem comprador autenticado valido.';
    end if;
    new.owner_user_id := v_order.user_id;
  else
    raise exception 'Origem do pedido nao permite inicializar proprietario.';
  end if;
  return new;
end;
$$;

create or replace function public.materialize_intended_ticket_owners_for_contact(p_contact_id uuid, p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if p_contact_id is null or p_user_id is null then return 0; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then return 0; end if;

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
      'owner_assigned', null, p_user_id, p_user_id, 'data_regularization',
      'Propriedade materializada a partir da Pessoa canonica vinculada a conta.'
    from owned
    returning ticket_id
  )
  select count(*)::integer into v_count from history;
  return v_count;
end;
$$;

revoke all on function public.materialize_intended_ticket_owners_for_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function public.materialize_intended_ticket_owners_for_contact(uuid, uuid) to service_role;

-- Depois do INSERT: se a Pessoa já tem conta, materializa owner + histórico.
-- Se ainda não tem conta, permanece pendente de claim seguro.
create or replace function public.trg_materialize_linked_ticket_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid := new.intended_owner_contact_id;
  v_user_id uuid;
  v_assigned integer := 0;
begin
  if v_contact_id is null then return new; end if;

  select c.user_id into v_user_id
  from public.registration_contacts c
  join auth.users au on au.id = c.user_id
  where c.id = v_contact_id;

  if v_user_id is null then
    return new;
  end if;

  if new.participant_id is not null then
    update public.participants p
    set user_id = v_user_id, updated_at = now()
    where p.id = new.participant_id
      and p.user_id is null
      and p.registration_contact_id = v_contact_id;
  end if;

  v_assigned := public.materialize_intended_ticket_owners_for_contact(v_contact_id, v_user_id);

  if v_assigned = 0 and new.owner_user_id is not distinct from v_user_id
    and not exists (
      select 1 from public.ticket_owner_history h where h.ticket_id = new.id
    ) then
    insert into public.ticket_owner_history (
      ticket_id, order_id, event_id, organization_id, operation,
      previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
    )
    values (
      new.id, new.order_id, new.event_id, new.organization_id, 'owner_assigned',
      null, v_user_id, v_user_id, 'data_regularization',
      'Propriedade materializada a partir da Pessoa canonica vinculada a conta.'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_materialize_linked_ticket_owner on public.tickets;
create trigger trg_materialize_linked_ticket_owner
after insert on public.tickets
for each row execute function public.trg_materialize_linked_ticket_owner();

revoke all on function public.trg_materialize_linked_ticket_owner() from public, anon, authenticated;
grant execute on function public.trg_materialize_linked_ticket_owner() to service_role;

create or replace function public.issue_manual_ticket_batch(
  p_registration_contact_id uuid, p_event_id uuid, p_ticket_category_id uuid, p_batch_id uuid, p_quantity integer,
  p_pricing_gender text, p_shirt_type text, p_shirt_size text, p_payment_method text, p_notes text default null,
  p_assign_holder boolean default true
) returns table(ticket_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_event_organization_id uuid;
  v_first record;
  v_extra record;
  v_index integer;
  v_owner_user_id uuid;
  v_issue_reason text := lower(trim(coalesce(p_payment_method, '')));
  v_financial_method constant text := 'courtesy';
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if v_issue_reason not in ('courtesy', 'system_failure', 'administrative_correction', 'other') then
    raise exception 'Motivo de emissao manual invalido.';
  end if;
  if v_issue_reason = 'other' and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Descreva o motivo da emissao manual.';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'Quantidade deve estar entre 1 e 20.';
  end if;
  select organization_id into v_event_organization_id from public.events where id = p_event_id;
  if v_event_organization_id is null then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event_organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;
  select * into v_contact from public.registration_contacts
  where id = p_registration_contact_id and organization_id = v_event_organization_id;
  if not found then raise exception 'Cadastro nao pertence a organizacao do evento.'; end if;
  perform set_config('app.administrative_ticket_issue_actor', v_actor::text, true);

  if coalesce(p_assign_holder, true) then
    perform public.assert_ticket_holder_contact_available(null, p_event_id, v_contact.id);
    select * into v_first from public.create_manual_registration_order(
      p_event_id, p_ticket_category_id, p_batch_id, v_contact.full_name, v_contact.cpf, v_contact.birth_date,
      p_pricing_gender, v_contact.phone, v_contact.email, v_contact.city, p_shirt_type, p_shirt_size, v_financial_method, p_notes);
    update public.participants
    set registration_contact_id = v_contact.id,
        user_id = case when user_id is null then v_contact.user_id else user_id end
    where id = v_first.participant_id;
    if not found then raise exception 'Falha ao vincular participante ao cadastro.'; end if;
    update public.order_items
    set registration_contact_id = v_contact.id,
        intended_owner_contact_id = coalesce(intended_owner_contact_id, v_contact.id)
    where id = v_first.order_item_id;
    if not found then raise exception 'Falha ao vincular item ao cadastro.'; end if;
    update public.tickets
    set intended_owner_contact_id = coalesce(intended_owner_contact_id, v_contact.id)
    where id = v_first.ticket_id;
    if v_contact.user_id is not null then
      perform public.materialize_intended_ticket_owners_for_contact(v_contact.id, v_contact.user_id);
    end if;
    v_owner_user_id := public.resolve_administrative_ticket_owner(v_event_organization_id, v_contact.id);
    update public.tickets
    set owner_user_id = v_owner_user_id
    where id = v_first.ticket_id
      and owner_user_id is null
      and v_owner_user_id is not null;
    if v_owner_user_id is not null and not exists (
      select 1 from public.ticket_owner_history h where h.ticket_id = v_first.ticket_id
    ) then
      insert into public.ticket_owner_history (
        ticket_id, order_id, event_id, organization_id, operation,
        previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
      )
      values (
        v_first.ticket_id, v_first.order_id, p_event_id, v_event_organization_id, 'owner_assigned',
        null, v_owner_user_id, v_actor, 'data_regularization',
        'Propriedade materializada na emissao administrativa para Pessoa com conta vinculada.'
      );
    end if;
    perform public.ensure_ticket_kit_items(v_first.ticket_id);
    ticket_id := v_first.ticket_id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values ('manual_ticket_issued', 'tickets', ticket_id, p_event_id, jsonb_build_object(
      'actor_user_id', v_actor, 'registration_contact_id', v_contact.id, 'order_id', v_first.order_id,
      'order_item_id', v_first.order_item_id, 'issue_reason', v_issue_reason,
      'reason_text', nullif(trim(coalesce(p_notes, '')), ''), 'payment_method', v_financial_method,
      'assign_holder', true, 'owner_user_id', v_owner_user_id, 'buyer_type', 'administrative',
      'organization_id', v_event_organization_id));
    return next;
    v_index := 2;
  else
    v_index := 1;
  end if;

  for v_index in v_index..p_quantity loop
    select * into v_extra from public.create_manual_unassigned_ticket_order(
      p_event_id, p_ticket_category_id, p_batch_id, p_pricing_gender, p_shirt_type, p_shirt_size, v_financial_method, p_notes);
    update public.tickets
    set owner_user_id = null, intended_owner_contact_id = null
    where id = v_extra.ticket_id;
    perform public.ensure_ticket_kit_items(v_extra.ticket_id);
    ticket_id := v_extra.ticket_id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values ('manual_ticket_issued', 'tickets', ticket_id, p_event_id, jsonb_build_object(
      'actor_user_id', v_actor, 'registration_contact_id', v_contact.id, 'order_id', v_extra.order_id,
      'order_item_id', v_extra.order_item_id, 'issue_reason', v_issue_reason,
      'reason_text', nullif(trim(coalesce(p_notes, '')), ''), 'payment_method', v_financial_method,
      'assign_holder', false, 'owner_user_id', null, 'buyer_type', 'administrative',
      'organization_id', v_event_organization_id));
    return next;
  end loop;
end;
$$;

revoke all on function public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean)
  to authenticated;

create or replace function public.claim_registration_contact_account_invite(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_auth_email text;
  v_inv public.participant_account_invites%rowtype;
  v_contact public.registration_contacts%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select lower(trim(email)) into v_auth_email from auth.users where id = v_actor;
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
    perform public.materialize_intended_ticket_owners_for_contact(v_contact.id, v_actor);
    perform public.reconcile_registration_contact_account(v_contact.id, v_actor);
    return v_contact.id;
  end if;
  if v_inv.status <> 'pending' or v_inv.expires_at <= now() then
    raise exception 'Convite invalido ou expirado.';
  end if;
  if v_inv.auth_user_id is distinct from v_actor
    or v_auth_email is distinct from lower(trim(v_inv.email)) then
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
  set status = 'claimed', claimed_user_id = v_actor,
      claimed_at = now(), updated_at = now()
  where id = v_inv.id;

  -- Defesa além do trigger em registration_contacts.user_id: o ingresso
  -- importado/administrativo precisa aparecer em Meus ingressos após o claim.
  perform public.materialize_intended_ticket_owners_for_contact(v_contact.id, v_actor);
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

revoke all on function public.claim_registration_contact_account_invite(uuid) from public, anon, authenticated;
grant execute on function public.claim_registration_contact_account_invite(uuid) to authenticated;
grant execute on function public.claim_registration_contact_account_invite(uuid) to service_role;

-- Reparo estrutural: Pessoas já vinculadas recebem ownership dos tickets
-- existentes sem recriar pedido, pagamento, ingresso ou estoque.
do $$
declare
  v_contact public.registration_contacts%rowtype;
begin
  for v_contact in
    select c.*
    from public.registration_contacts c
    join auth.users au on au.id = c.user_id
    where c.user_id is not null
  loop
    update public.participants p
    set user_id = v_contact.user_id, updated_at = now()
    where p.registration_contact_id = v_contact.id
      and p.organization_id = v_contact.organization_id
      and p.user_id is null;

    perform public.materialize_intended_ticket_owners_for_contact(v_contact.id, v_contact.user_id);
    perform public.reconcile_registration_contact_account(v_contact.id, v_contact.user_id);
  end loop;
end;
$$;

commit;
