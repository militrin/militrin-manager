-- 1 e-mail normalizado = no maximo 1 identidade autenticavel por organization.
-- Varios Cadastros podem compartilhar o e-mail como titulares.
-- Nao cria unique(email) em registration_contacts.
-- Nao executa backfill nem altera tickets.

begin;

create or replace function public.normalized_contact_email(p_email text)
returns text
language sql
immutable
as $$
  select nullif(lower(trim(coalesce(p_email, ''))), '');
$$;

create or replace function public.email_already_has_account_message()
returns text
language sql
immutable
as $$
  select 'Este e-mail já está vinculado a outra conta. Esta pessoa pode permanecer como titular, mas não pode criar uma segunda conta com o mesmo e-mail.';
$$;

create or replace function public.registration_email_account_owner(
  p_organization_id uuid,
  p_email text,
  p_except_contact_id uuid default null
)
returns table(contact_id uuid, full_name text, user_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id, c.full_name, c.user_id
  from public.registration_contacts c
  where c.organization_id = p_organization_id
    and c.user_id is not null
    and public.normalized_contact_email(c.email) is not null
    and public.normalized_contact_email(c.email) = public.normalized_contact_email(p_email)
    and (p_except_contact_id is null or c.id is distinct from p_except_contact_id)
  order by c.created_at, c.id
  limit 1;
$$;

create unique index if not exists ux_registration_contacts_one_user_per_normalized_email
  on public.registration_contacts (organization_id, (lower(trim(email))))
  where user_id is not null
    and nullif(trim(email), '') is not null;

create or replace function public.trg_registration_contacts_one_auth_per_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner record;
begin
  if new.user_id is null then
    return new;
  end if;
  if public.normalized_contact_email(new.email) is null then
    return new;
  end if;

  select * into v_owner
  from public.registration_email_account_owner(new.organization_id, new.email, new.id);
  if found then
    raise exception '%', public.email_already_has_account_message()
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_registration_contacts_one_auth_per_email on public.registration_contacts;
create trigger trg_registration_contacts_one_auth_per_email
  before insert or update of user_id, email, organization_id
  on public.registration_contacts
  for each row
  execute function public.trg_registration_contacts_one_auth_per_email();

create or replace function public.revoke_registration_contact_pending_invites(
  p_registration_contact_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_count integer := 0;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then
    if auth.role() is distinct from 'service_role'
       and session_user not in ('postgres', 'supabase_admin') then
      raise exception 'Sem permissao.';
    end if;
  end if;

  select * into v_contact
  from public.registration_contacts
  where id = p_registration_contact_id
  for update;
  if not found then
    raise exception 'Pessoa nao encontrada.';
  end if;
  if v_actor is not null
     and not public.user_can_access_organization(v_actor, v_contact.organization_id) then
    raise exception 'Pessoa fora da organizacao atual.';
  end if;

  with revoked as (
    update public.participant_account_invites
    set status = 'revoked', updated_at = now()
    where registration_contact_id = v_contact.id
      and status = 'pending'
    returning id
  )
  select count(*)::integer into v_count from revoked;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'registration_contact_account_invite_revoked',
    'registration_contacts',
    v_contact.id,
    null,
    jsonb_build_object(
      'organization_id', v_contact.organization_id,
      'revoked_count', v_count,
      'actor_user_id', v_actor,
      'reason', 'email_already_has_account'
    )
  );
  return v_count;
end;
$$;

create or replace function public.check_registration_contact_account_invite_eligibility(
  p_registration_contact_id uuid
)
returns table(eligible boolean, reason_code text, reason_message text, email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_email text;
  v_cpf text;
  v_auth_count integer;
  v_auth_user_id uuid;
  v_shared integer;
  v_other_intended integer;
  v_owner record;
  v_class record;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao.';
  end if;

  select rc.* into v_contact
  from public.registration_contacts rc
  where rc.id = p_registration_contact_id;

  if not found or not public.user_can_access_organization(v_actor, v_contact.organization_id) then
    return query select false, 'inaccessible', 'Cadastro invalido ou sem acesso.', null::text;
    return;
  end if;
  if v_contact.user_id is not null then
    return query select false, 'already_linked', 'Conta ja vinculada.', null::text;
    return;
  end if;
  if nullif(trim(coalesce(v_contact.email, '')), '') is null then
    return query select false, 'missing_email', 'Sem e-mail.', null::text;
    return;
  end if;

  v_email := public.normalized_contact_email(v_contact.email);
  if v_email is null or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return query select false, 'invalid_email', 'E-mail invalido.', v_email;
    return;
  end if;

  select * into v_owner
  from public.registration_email_account_owner(v_contact.organization_id, v_contact.email, v_contact.id);
  if found then
    return query select false, 'email_already_has_account', public.email_already_has_account_message(), v_email;
    return;
  end if;

  select count(*) into v_shared
  from public.registration_contacts other
  where other.organization_id = v_contact.organization_id
    and other.id <> v_contact.id
    and public.normalized_contact_email(other.email) = v_email;

  if v_shared > 0 then
    select count(*) into v_other_intended
    from public.tickets t
    where t.intended_owner_contact_id is not null
      and t.intended_owner_contact_id <> v_contact.id
      and t.status not in ('cancelled','canceled','void','voided')
      and t.intended_owner_contact_id in (
        select other.id from public.registration_contacts other
        where other.organization_id = v_contact.organization_id
          and other.id <> v_contact.id
          and public.normalized_contact_email(other.email) = v_email
      );
    if v_other_intended > 0 then
      return query select false, 'email_conflict', 'E-mail compartilhado. Outra Pessoa ja e a conta proprietaria destes ingressos.', v_email;
      return;
    end if;
    if not exists (
      select 1 from public.tickets t
      where t.intended_owner_contact_id = v_contact.id
        and t.status not in ('cancelled','canceled','void','voided')
    ) and not exists (
      select 1 from public.order_items oi
      where oi.intended_owner_contact_id = v_contact.id
        and oi.status not in ('cancelled','expired','refunded')
    ) then
      return query select false, 'email_conflict', 'E-mail compartilhado. Escolha a Pessoa dona da conta na revisao de importacao.', v_email;
      return;
    end if;
  end if;

  if public.is_valid_cpf(v_contact.cpf) then
    v_cpf := regexp_replace(coalesce(v_contact.cpf, ''), '\D', '', 'g');
    if exists (
      select 1 from public.registration_contacts other
      where other.organization_id = v_contact.organization_id
        and other.id <> v_contact.id
        and regexp_replace(coalesce(other.cpf, ''), '\D', '', 'g') = v_cpf
    ) then
      return query select false, 'cpf_conflict', 'CPF em conflito com outra Pessoa.', v_email;
      return;
    end if;
  else
    v_cpf := regexp_replace(coalesce(v_contact.cpf, ''), '\D', '', 'g');
  end if;

  select count(*) into v_auth_count
  from auth.users au
  where public.normalized_contact_email(au.email) = v_email;
  if v_auth_count = 0 then
    return query select true, 'eligible', 'Cadastro apto para convite.', v_email;
    return;
  end if;
  if v_auth_count <> 1 then
    return query select false, 'account_attention', 'Esta conta requer tratamento administrativo.', v_email;
    return;
  end if;

  select au.id into v_auth_user_id
  from auth.users au
  where public.normalized_contact_email(au.email) = v_email;

  select * into v_class
  from public.classify_existing_auth_for_invite(
    v_auth_user_id, v_email, v_cpf, v_contact.id, null
  );
  return query select v_class.eligible, v_class.reason_code, v_class.reason_message, v_email;
end;
$$;

create or replace function public.get_registration_contact_account_state(
  p_registration_contact_id uuid
)
returns table(
  state text,
  reason_code text,
  reason_message text,
  email text,
  can_resend_confirmation boolean,
  can_invite boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_check record;
  v_state text;
  v_can_resend boolean := false;
  v_can_invite boolean := false;
  v_owner record;
begin
  if v_actor is null or not (
    public.current_user_has_permission('participants.view')
    or public.current_user_has_permission('participants.edit_basic')
    or public.current_user_has_permission('orders.view')
  ) then
    raise exception 'Sem permissao.';
  end if;

  select rc.* into v_contact
  from public.registration_contacts rc
  where rc.id = p_registration_contact_id;
  if not found or not public.user_can_access_organization(v_actor, v_contact.organization_id) then
    return query select 'attention'::text, 'inaccessible'::text, 'Cadastro invalido ou sem acesso.'::text, null::text, false, false;
    return;
  end if;

  if v_contact.user_id is not null then
    return query select
      'active'::text,
      'already_linked'::text,
      'Conta vinculada.'::text,
      public.normalized_contact_email(v_contact.email),
      false,
      false;
    return;
  end if;

  select * into v_owner
  from public.registration_email_account_owner(v_contact.organization_id, v_contact.email, v_contact.id);
  if found then
    return query select
      'linked_to_other_account'::text,
      'email_already_has_account'::text,
      public.email_already_has_account_message(),
      public.normalized_contact_email(v_contact.email),
      false,
      false;
    return;
  end if;

  if not public.current_user_has_permission('participants.edit_basic') then
    return query select
      'none'::text,
      'forbidden'::text,
      'Sem permissao para avaliar convite.'::text,
      public.normalized_contact_email(v_contact.email),
      false,
      false;
    return;
  end if;

  select * into v_check
  from public.check_registration_contact_account_invite_eligibility(p_registration_contact_id);

  if v_check.reason_code = 'pending_email_confirmation' then
    v_state := 'pending_confirmation';
    v_can_resend := true;
  elsif v_check.reason_code = 'invite_existing_confirmed_account'
     or v_check.reason_code like 'resend_invite_%' then
    v_state := 'existing_confirmed';
    v_can_invite := coalesce(v_check.eligible, false);
  elsif v_check.reason_code = 'eligible' and coalesce(v_check.eligible, false) then
    v_state := 'none';
    v_can_invite := true;
  elsif v_check.reason_code = 'already_linked' then
    v_state := 'active';
  elsif v_check.reason_code = 'email_already_has_account' then
    v_state := 'linked_to_other_account';
  else
    v_state := 'attention';
  end if;

  return query select
    v_state,
    coalesce(v_check.reason_code, 'evaluation_error'),
    coalesce(v_check.reason_message, 'Nao foi possivel avaliar a conta.'),
    v_check.email,
    v_can_resend,
    v_can_invite;
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
    select 1 from public.registration_email_account_owner(
      v_contact.organization_id, v_contact.email, v_contact.id
    )
  ) then
    raise exception '%', public.email_already_has_account_message();
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

revoke all on function public.normalized_contact_email(text) from public, anon;
grant execute on function public.normalized_contact_email(text) to authenticated, service_role;
revoke all on function public.email_already_has_account_message() from public, anon;
grant execute on function public.email_already_has_account_message() to authenticated, service_role;
revoke all on function public.registration_email_account_owner(uuid, text, uuid) from public, anon;
grant execute on function public.registration_email_account_owner(uuid, text, uuid) to authenticated, service_role;
revoke all on function public.revoke_registration_contact_pending_invites(uuid) from public, anon;
grant execute on function public.revoke_registration_contact_pending_invites(uuid) to authenticated, service_role;
revoke all on function public.check_registration_contact_account_invite_eligibility(uuid) from public, anon;
grant execute on function public.check_registration_contact_account_invite_eligibility(uuid) to authenticated, service_role;
revoke all on function public.get_registration_contact_account_state(uuid) from public, anon;
grant execute on function public.get_registration_contact_account_state(uuid) to authenticated, service_role;
revoke all on function public.claim_registration_contact_account_invite(uuid) from public, anon, authenticated;
grant execute on function public.claim_registration_contact_account_invite(uuid) to authenticated, service_role;

create or replace function public.ensure_registration_contact_for_user(
  p_user_id uuid,
  p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_profile record;
  v_email text;
  v_email_confirmed_at timestamptz;
  v_cpf text;
  v_contact_id uuid;
  v_existing record;
  v_conflict_user_id uuid;
begin
  if p_user_id is null then
    raise exception 'Usuario obrigatorio.';
  end if;

  if v_actor is not null and v_actor <> p_user_id
     and not public.current_user_has_permission('participants.create') then
    raise exception 'Sem permissao para vincular este cadastro.';
  end if;

  select full_name, cpf, birth_date, gender, phone, city
    into v_profile
    from public.customer_profiles
    where user_id = p_user_id;

  if not found then
    return null;
  end if;

  select email, email_confirmed_at into v_email, v_email_confirmed_at from auth.users where id = p_user_id;
  v_cpf := regexp_replace(coalesce(v_profile.cpf, ''), '\D', '', 'g');

  if length(v_cpf) <> 11
     or nullif(trim(coalesce(v_profile.full_name, '')), '') is null
     or v_profile.birth_date is null
     or nullif(trim(coalesce(v_profile.phone, '')), '') is null
     or nullif(trim(coalesce(v_email, '')), '') is null
     or v_email_confirmed_at is null
  then
    return null;
  end if;

  if p_organization_id is null then
    p_organization_id := public.resolve_default_registration_organization();
    if p_organization_id is null then
      return null;
    end if;
  end if;

  if (select fc.has_conflict from public.find_conflicting_registration_contact(v_cpf, p_user_id, p_organization_id) fc) then
    raise exception using errcode = 'P0001', message = 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
      detail = jsonb_build_object('code', 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        'message', 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.')::text;
  end if;

  select id into v_contact_id
    from public.registration_contacts
    where organization_id = p_organization_id and user_id = p_user_id;

  if v_contact_id is not null then
    update public.registration_contacts set
      full_name = coalesce(nullif(trim(full_name), ''), trim(v_profile.full_name)),
      birth_date = coalesce(birth_date, v_profile.birth_date),
      gender = coalesce(nullif(trim(coalesce(gender, '')), ''), nullif(trim(coalesce(v_profile.gender, '')), '')),
      phone = coalesce(nullif(trim(coalesce(phone, '')), ''), trim(v_profile.phone)),
      city = coalesce(nullif(trim(coalesce(city, '')), ''), nullif(trim(coalesce(v_profile.city, '')), '')),
      updated_at = now()
      where id = v_contact_id;
    return v_contact_id;
  end if;

  if exists (
    select 1 from public.registration_email_account_owner(p_organization_id, v_email, null)
  ) then
    raise exception using errcode = 'P0001', message = 'EMAIL_ALREADY_LINKED_TO_ANOTHER_USER',
      detail = jsonb_build_object('code', 'EMAIL_ALREADY_LINKED_TO_ANOTHER_USER',
        'message', public.email_already_has_account_message())::text;
  end if;

  select id, user_id into v_existing
    from public.registration_contacts
    where organization_id = p_organization_id and cpf = v_cpf
    for update;

  if v_existing.id is not null then
    if v_existing.user_id is not null and v_existing.user_id is distinct from p_user_id then
      raise exception using errcode = 'P0001', message = 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        detail = jsonb_build_object('code', 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
          'message', 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.')::text;
    end if;

    if exists (
      select 1 from public.registration_email_account_owner(p_organization_id, v_email, v_existing.id)
    ) then
      raise exception using errcode = 'P0001', message = 'EMAIL_ALREADY_LINKED_TO_ANOTHER_USER',
        detail = jsonb_build_object('code', 'EMAIL_ALREADY_LINKED_TO_ANOTHER_USER',
          'message', public.email_already_has_account_message())::text;
    end if;

    if v_existing.user_id is null
       and public.registration_contact_has_protected_identity_rights(v_existing.id)
       and not public.registration_contact_invite_authorizes_user(v_existing.id, p_user_id, false) then
      raise exception using errcode = 'P0001', message = 'REGISTRATION_CONTACT_REQUIRES_INVITE',
        detail = jsonb_build_object('code', 'REGISTRATION_CONTACT_REQUIRES_INVITE',
          'message', 'Este CPF pertence a um cadastro existente. Use o convite de primeiro acesso enviado pela organização.')::text;
    end if;

    update public.registration_contacts set
      user_id = p_user_id,
      full_name = coalesce(nullif(trim(full_name), ''), trim(v_profile.full_name)),
      birth_date = coalesce(birth_date, v_profile.birth_date),
      gender = coalesce(nullif(trim(coalesce(gender, '')), ''), nullif(trim(coalesce(v_profile.gender, '')), '')),
      phone = coalesce(nullif(trim(coalesce(phone, '')), ''), trim(v_profile.phone)),
      email = coalesce(nullif(trim(coalesce(email, '')), ''), lower(trim(v_email))),
      city = coalesce(nullif(trim(coalesce(city, '')), ''), nullif(trim(coalesce(v_profile.city, '')), '')),
      updated_at = now()
      where id = v_existing.id
        and (user_id is null or user_id = p_user_id)
      returning id into v_contact_id;

    if v_contact_id is null then
      raise exception using errcode = 'P0001', message = 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        detail = jsonb_build_object('code', 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
          'message', 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.')::text;
    end if;

    return v_contact_id;
  end if;

  insert into public.registration_contacts(
    organization_id, user_id, full_name, cpf, birth_date, gender, phone, email, city, created_by
  ) values (
    p_organization_id, p_user_id, trim(v_profile.full_name), v_cpf, v_profile.birth_date,
    nullif(trim(coalesce(v_profile.gender, '')), ''), trim(v_profile.phone), lower(trim(v_email)),
    nullif(trim(coalesce(v_profile.city, '')), ''), p_user_id
  )
  on conflict (organization_id, cpf) do update set
    user_id = excluded.user_id,
    updated_at = now()
  where registration_contacts.user_id is not distinct from excluded.user_id
     or (
       registration_contacts.user_id is null
       and (
         not public.registration_contact_has_protected_identity_rights(registration_contacts.id)
         or public.registration_contact_invite_authorizes_user(registration_contacts.id, excluded.user_id, false)
       )
     )
  returning id into v_contact_id;

  if v_contact_id is null then
    select rc.user_id into v_conflict_user_id
      from public.registration_contacts rc
      where rc.organization_id = p_organization_id and rc.cpf = v_cpf;
    if found and v_conflict_user_id is distinct from p_user_id then
      raise exception using errcode = 'P0001', message = 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
        detail = jsonb_build_object('code', 'CPF_ALREADY_LINKED_TO_ANOTHER_USER',
          'message', 'Este CPF já está vinculado a outra conta. Entre com a conta existente ou recupere sua senha.')::text;
    end if;
    raise exception using errcode = 'P0001', message = 'REGISTRATION_CONTACT_REQUIRES_INVITE',
      detail = jsonb_build_object('code', 'REGISTRATION_CONTACT_REQUIRES_INVITE',
        'message', 'Este CPF pertence a um cadastro existente. Use o convite de primeiro acesso enviado pela organização.')::text;
  end if;

  return v_contact_id;
end;
$$;

revoke all on function public.ensure_registration_contact_for_user(uuid, uuid) from public, anon;
grant execute on function public.ensure_registration_contact_for_user(uuid, uuid) to authenticated, service_role;

create or replace function public.invite_center_ui_status(
  p_mixed_intended_owners boolean,
  p_invite_status text,
  p_auth_link_expires_at timestamptz,
  p_account_status text,
  p_must_complete_profile boolean,
  p_must_change_password boolean,
  p_activation_completed_at timestamptz,
  p_cadastral_incomplete boolean,
  p_job_status text,
  p_auth_confirmed_at timestamptz default null,
  p_password_setup_completed_at timestamptz default null
) returns text
language sql
immutable
as $$
  select case
    when coalesce(p_mixed_intended_owners, false) then 'admin_action'
    when coalesce(p_must_complete_profile, false) is false
      and coalesce(p_must_change_password, false) is false
      and coalesce(p_account_status, '') = 'active'
      then 'concluido'
    when coalesce(p_must_complete_profile, false) is false
      and coalesce(p_must_change_password, false) is false
      and coalesce(p_cadastral_incomplete, false) is false
      and (
        p_activation_completed_at is not null
        or (p_invite_status = 'claimed' and p_password_setup_completed_at is not null)
      )
      then 'concluido'
    when p_invite_status = 'claimed' or p_auth_confirmed_at is not null then 'cadastro_pendente'
    when p_invite_status = 'pending' and p_auth_link_expires_at is not null and p_auth_link_expires_at <= now() then 'expirado'
    when p_invite_status = 'expired' then 'expirado'
    when p_invite_status = 'pending' then 'pendente'
    when p_job_status = 'failed' then 'falha'
    when p_job_status = 'skipped' then 'pulado'
    else 'nao_enviado'
  end;
$$;

revoke all on function public.invite_center_ui_status(boolean, text, timestamptz, text, boolean, boolean, timestamptz, boolean, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.invite_center_ui_status(boolean, text, timestamptz, text, boolean, boolean, timestamptz, boolean, text, timestamptz, timestamptz) to authenticated, service_role;

commit;
