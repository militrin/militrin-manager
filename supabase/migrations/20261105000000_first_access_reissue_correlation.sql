-- First access reissue: convite interno atual ↔ Auth ↔ redirect ↔ onboarding.
-- Reenvio reutiliza o convite pending da mesma Pessoa (nao cria A→B→C).
-- Ativacao de conta nao materializa owner_user_id (CONTA ≠ TITULAR).
-- GUC app.skip_ticket_ownership_on_account_claim e set_config(..., is_local=true):
-- vale SOMENTE na transacao do claim. Emissao admin / vinculo admin / trigger
-- fora dessa transacao continuam materializando como hoje.
-- Nao usa 20261104 (reservado/fora desta entrega).

begin;

create or replace function public.materialize_intended_ticket_owners_for_contact(p_contact_id uuid, p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if current_setting('app.skip_ticket_ownership_on_account_claim', true) = '1' then
    return 0;
  end if;
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

create or replace function public.prepare_registration_contact_account_invite(
  p_registration_contact_id uuid
)
returns table(invite_id uuid, email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_check record;
  v_id uuid;
begin
  select * into v_check
  from public.check_registration_contact_account_invite_eligibility(p_registration_contact_id);
  if not coalesce(v_check.eligible, false) then
    raise exception '%', coalesce(v_check.reason_message, 'Cadastro nao elegivel.');
  end if;

  select * into v_contact
  from public.registration_contacts
  where id = p_registration_contact_id
  for update;

  if exists (
    select 1
    from public.participant_account_invites pai
    where pai.organization_id = v_contact.organization_id
      and pai.status = 'pending'
      and lower(trim(pai.email)) = v_check.email
      and pai.registration_contact_id is distinct from v_contact.id
  ) then
    raise exception 'Ja existe convite pendente para este e-mail.';
  end if;

  -- Reenvio idempotente: renovar o pending atual (mesmo expirado) sem novo id.
  update public.participant_account_invites
  set
    email = v_check.email,
    invited_by = v_actor,
    expires_at = now() + interval '7 days',
    updated_at = now()
  where registration_contact_id = v_contact.id
    and status = 'pending'
  returning id into v_id;

  if v_id is not null then
    return query select v_id, v_check.email::text;
    return;
  end if;

  insert into public.participant_account_invites(
    organization_id, registration_contact_id, email, invited_by,
    requires_password_setup
  ) values (
    v_contact.organization_id, v_contact.id, v_check.email, v_actor, false
  )
  on conflict(registration_contact_id)
    where status = 'pending' and registration_contact_id is not null
  do update set
    email = excluded.email,
    invited_by = excluded.invited_by,
    expires_at = now() + interval '7 days',
    updated_at = now()
  returning id into v_id;

  return query select v_id, v_check.email::text;
end;
$$;

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

  if current_setting('app.skip_ticket_ownership_on_account_claim', true) is distinct from '1' then
    with owned as (
      update public.tickets as ticket
      set owner_user_id = p_user_id
      where ticket.organization_id = v_contact.organization_id
        and ticket.owner_user_id is null
        and (
          exists (
            select 1 from public.participants as holder
            where holder.id = ticket.participant_id
              and holder.registration_contact_id = v_contact.id
          )
          or exists (
            select 1 from public.order_items as item
            where item.id = ticket.order_item_id
              and item.registration_contact_id = v_contact.id
          )
        )
      returning ticket.id, ticket.order_id, ticket.event_id, ticket.organization_id
    ), history as (
      insert into public.ticket_owner_history(
        ticket_id, order_id, event_id, organization_id, operation,
        previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
      )
      select owned.id, owned.order_id, owned.event_id, owned.organization_id,
        'owner_assigned', null, p_user_id, coalesce(v_actor, p_user_id),
        'data_regularization',
        'Propriedade materializada a partir da Pessoa canonica vinculada a conta.'
      from owned
      returning ticket_id
    )
    select count(*)::integer into v_ticket_count from history;
  end if;

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
  -- is_local=true: some no COMMIT/ROLLBACK. Nao vaza para outro request do pool.
  perform set_config('app.skip_ticket_ownership_on_account_claim', '1', true);
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

revoke all on function public.materialize_intended_ticket_owners_for_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function public.materialize_intended_ticket_owners_for_contact(uuid, uuid) to service_role;
revoke all on function public.prepare_registration_contact_account_invite(uuid) from public, anon, authenticated;
grant execute on function public.prepare_registration_contact_account_invite(uuid) to authenticated, service_role;
revoke all on function public.reconcile_registration_contact_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reconcile_registration_contact_account(uuid, uuid) to service_role;
revoke all on function public.claim_registration_contact_account_invite(uuid) from public, anon, authenticated;
grant execute on function public.claim_registration_contact_account_invite(uuid) to authenticated, service_role;

commit;
