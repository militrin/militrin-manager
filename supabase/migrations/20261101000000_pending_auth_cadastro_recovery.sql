-- P0: Auth pendente x Cadastro.
-- Distingue Auth inexistente, pendente, confirmada e incompatível.
-- Nao lista auth.users em /cadastros. Nao cria Cadastro so porque existe Auth.
-- Nao altera ownership de ingresso.

begin;

create or replace function public.classify_existing_auth_for_invite(
  p_auth_user_id uuid,
  p_email text,
  p_cpf text,
  p_contact_id uuid,
  p_participant_id uuid
)
returns table(eligible boolean, reason_code text, reason_message text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_auth auth.users%rowtype;
  v_inv public.participant_account_invites%rowtype;
  v_profile_cpf text;
  v_linked_other boolean := false;
  v_owns_ticket boolean := false;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
begin
  select * into v_auth from auth.users au where au.id = p_auth_user_id;
  if not found then
    return query select true, 'eligible', 'Cadastro apto para convite.';
    return;
  end if;

  select exists (
    select 1 from public.registration_contacts c
    where c.user_id = v_auth.id
      and (p_contact_id is null or c.id is distinct from p_contact_id)
  ) into v_linked_other;
  if not v_linked_other then
    select exists (
      select 1 from public.participants p
      where p.user_id = v_auth.id
        and (p_participant_id is null or p.id is distinct from p_participant_id)
    ) into v_linked_other;
  end if;

  select exists (
    select 1 from public.tickets t
    where t.owner_user_id = v_auth.id
      and t.status not in ('cancelled', 'canceled', 'void', 'voided')
  ) into v_owns_ticket;

  select regexp_replace(coalesce(cp.cpf, ''), '\D', '', 'g') into v_profile_cpf
  from public.customer_profiles cp
  where cp.user_id = v_auth.id;

  if v_auth.email_confirmed_at is null then
    if v_linked_other or v_owns_ticket then
      return query select false, 'account_attention', 'Esta conta requer tratamento administrativo.';
      return;
    end if;
    if nullif(v_profile_cpf, '') is not null
       and length(v_cpf) = 11
       and v_profile_cpf <> v_cpf then
      return query select false, 'account_attention', 'Esta conta requer tratamento administrativo.';
      return;
    end if;
    return query select false, 'pending_email_confirmation', 'Conta pendente de confirmação.';
    return;
  end if;

  if v_linked_other then
    return query select false, 'account_attention', 'Esta conta requer tratamento administrativo.';
    return;
  end if;

  if nullif(v_profile_cpf, '') is not null
     and length(v_cpf) = 11
     and v_profile_cpf <> v_cpf then
    return query select false, 'account_attention', 'Esta conta requer tratamento administrativo.';
    return;
  end if;

  select pai.* into v_inv
  from public.participant_account_invites pai
  where pai.status = 'pending'
    and lower(trim(pai.email)) = v_email
    and (
      (p_contact_id is not null and pai.registration_contact_id = p_contact_id)
      or (p_participant_id is not null and pai.participant_id = p_participant_id)
    )
    and (
      pai.auth_user_id = v_auth.id
      or (pai.auth_user_id is null and v_auth.raw_user_meta_data->>'participant_invite_id' = pai.id::text)
    )
  order by pai.created_at desc
  limit 1;
  if found then
    return query select true, 'resend_invite_existing_account', 'Convite pendente pode ser reenviado.';
    return;
  end if;

  return query select true, 'invite_existing_confirmed_account', 'Conta existente pode receber o acesso de vínculo.';
end;
$$;

revoke all on function public.classify_existing_auth_for_invite(uuid, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.find_auth_email_confirmation_status(p_email text)
returns table(user_id uuid, email_confirmed boolean)
language sql
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.email_confirmed_at is not null
  from auth.users u
  where lower(trim(coalesce(u.email, ''))) = lower(trim(coalesce(p_email, '')))
  limit 1;
$$;

revoke all on function public.find_auth_email_confirmation_status(text)
  from public, anon, authenticated;
grant execute on function public.find_auth_email_confirmation_status(text) to service_role;

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

  v_email := lower(trim(v_contact.email));
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return query select false, 'invalid_email', 'E-mail invalido.', v_email;
    return;
  end if;

  select count(*) into v_shared
  from public.registration_contacts other
  where other.organization_id = v_contact.organization_id
    and other.id <> v_contact.id
    and lower(trim(coalesce(other.email, ''))) = v_email;

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
          and lower(trim(coalesce(other.email, ''))) = v_email
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
  where lower(trim(coalesce(au.email, ''))) = v_email;
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
  where lower(trim(coalesce(au.email, ''))) = v_email;

  select * into v_class
  from public.classify_existing_auth_for_invite(
    v_auth_user_id, v_email, v_cpf, v_contact.id, null
  );
  return query select v_class.eligible, v_class.reason_code, v_class.reason_message, v_email;
end;
$$;

create or replace function public.check_participant_account_invite_eligibility(p_participant_id uuid)
returns table(eligible boolean, reason_code text, reason_message text, email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_p public.participants%rowtype;
  v_email text;
  v_same_email integer;
  v_auth_count integer;
  v_auth_user_id uuid;
  v_class record;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then
    raise exception 'Sem permissao.';
  end if;
  select p.* into v_p from public.participants p where p.id = p_participant_id;
  if not found or not public.user_can_access_organization(v_actor, v_p.organization_id) then
    return query select false, 'inaccessible', 'Cadastro invalido ou sem acesso.', null::text;
    return;
  end if;
  if v_p.registration_contact_id is not null then
    return query
      select e.eligible, e.reason_code, e.reason_message, e.email
      from public.check_registration_contact_account_invite_eligibility(v_p.registration_contact_id) e;
    return;
  end if;
  if v_p.user_id is not null then
    return query select false, 'already_linked', 'Cadastro ja vinculado a uma conta.', null::text;
    return;
  end if;
  if nullif(trim(coalesce(v_p.email, '')), '') is null then
    return query select false, 'missing_email', 'E-mail ausente.', null::text;
    return;
  end if;
  v_email := lower(trim(v_p.email));
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return query select false, 'invalid_email', 'E-mail invalido.', v_email;
    return;
  end if;
  if not public.is_valid_cpf(v_p.cpf) then
    return query select false, 'invalid_cpf', 'CPF invalido.', v_email;
    return;
  end if;
  select count(*) into v_same_email
  from public.participants p
  where p.organization_id = v_p.organization_id
    and p.user_id is null
    and lower(trim(coalesce(p.email, ''))) = v_email;
  if v_same_email <> 1 then
    return query select false, 'shared_email', 'E-mail compartilhado por mais de um cadastro.', v_email;
    return;
  end if;

  select count(*) into v_auth_count from auth.users au where lower(trim(coalesce(au.email, ''))) = v_email;
  if v_auth_count = 0 then
    return query select true, 'eligible', 'Cadastro apto para convite.', v_email;
    return;
  end if;
  if v_auth_count <> 1 then
    return query select false, 'account_attention', 'Esta conta requer tratamento administrativo.', v_email;
    return;
  end if;
  select au.id into v_auth_user_id from auth.users au where lower(trim(coalesce(au.email, ''))) = v_email;

  select * into v_class
  from public.classify_existing_auth_for_invite(
    v_auth_user_id, v_email, v_p.cpf, null, v_p.id
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
      lower(trim(coalesce(v_contact.email, '')))::text,
      false,
      false;
    return;
  end if;

  if not public.current_user_has_permission('participants.edit_basic') then
    return query select
      'none'::text,
      'forbidden'::text,
      'Sem permissao para avaliar convite.'::text,
      lower(trim(coalesce(v_contact.email, '')))::text,
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

revoke all on function public.check_registration_contact_account_invite_eligibility(uuid)
  from public, anon;
grant execute on function public.check_registration_contact_account_invite_eligibility(uuid)
  to authenticated, service_role;

revoke all on function public.check_participant_account_invite_eligibility(uuid)
  from public, anon;
grant execute on function public.check_participant_account_invite_eligibility(uuid)
  to authenticated, service_role;

revoke all on function public.get_registration_contact_account_state(uuid)
  from public, anon;
grant execute on function public.get_registration_contact_account_state(uuid)
  to authenticated, service_role;

commit;
