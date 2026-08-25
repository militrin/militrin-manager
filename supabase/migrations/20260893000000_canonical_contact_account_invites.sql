-- Account invitations belong to the canonical Person. Event participants remain
-- optional context for legacy/import invitation flows.

alter table public.participant_account_invites
  add column if not exists registration_contact_id uuid
    references public.registration_contacts(id) on delete cascade;

update public.participant_account_invites pai
set registration_contact_id = p.registration_contact_id
from public.participants p
where p.id = pai.participant_id
  and pai.registration_contact_id is null
  and p.registration_contact_id is not null;

alter table public.participant_account_invites
  alter column event_id drop not null,
  alter column participant_id drop not null;

alter table public.participant_account_invites
  drop constraint if exists participant_account_invites_has_person_check;
alter table public.participant_account_invites
  add constraint participant_account_invites_has_person_check check (
    registration_contact_id is not null or participant_id is not null
  );

create or replace function public.set_account_invite_canonical_contact()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
  v_organization_id uuid;
begin
  if new.participant_id is not null then
    select p.registration_contact_id, p.organization_id
    into v_contact_id, v_organization_id
    from public.participants p where p.id = new.participant_id;
    if v_organization_id is distinct from new.organization_id then
      raise exception 'Participante nao pertence a organizacao do convite.';
    end if;
    new.registration_contact_id := coalesce(new.registration_contact_id, v_contact_id);
  end if;
  if new.registration_contact_id is not null and not exists (
    select 1 from public.registration_contacts rc
    where rc.id = new.registration_contact_id
      and rc.organization_id = new.organization_id
  ) then
    raise exception 'Pessoa nao pertence a organizacao do convite.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_account_invite_canonical_contact
  on public.participant_account_invites;
create trigger trg_set_account_invite_canonical_contact
before insert or update of participant_id, registration_contact_id, organization_id
on public.participant_account_invites
for each row execute function public.set_account_invite_canonical_contact();

create index if not exists idx_participant_account_invites_contact
  on public.participant_account_invites(registration_contact_id, status, expires_at);

-- Older event-scoped invitations could leave more than one pending row for the
-- same Person. Keep the newest one before enforcing the canonical invariant.
with ranked_pending as (
  select id, row_number() over (
    partition by registration_contact_id order by created_at desc, id desc
  ) as position
  from public.participant_account_invites
  where status = 'pending' and registration_contact_id is not null
)
update public.participant_account_invites pai
set status = 'revoked', updated_at = now()
from ranked_pending ranked
where ranked.id = pai.id and ranked.position > 1;

create unique index if not exists ux_participant_account_invites_contact_pending
  on public.participant_account_invites(registration_contact_id)
  where status = 'pending' and registration_contact_id is not null;

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
  v_auth_user auth.users%rowtype;
  v_inv public.participant_account_invites%rowtype;
  v_profile_cpf text;
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
  if not public.is_valid_cpf(v_contact.cpf) then
    return query select false, 'invalid_cpf', 'CPF invalido.', v_email;
    return;
  end if;
  v_cpf := regexp_replace(coalesce(v_contact.cpf, ''), '\D', '', 'g');

  if exists (
    select 1 from public.registration_contacts other
    where other.organization_id = v_contact.organization_id
      and other.id <> v_contact.id
      and lower(trim(coalesce(other.email, ''))) = v_email
  ) then
    return query select false, 'email_conflict', 'E-mail em conflito com outra Pessoa.', v_email;
    return;
  end if;
  if exists (
    select 1 from public.registration_contacts other
    where other.organization_id = v_contact.organization_id
      and other.id <> v_contact.id
      and regexp_replace(coalesce(other.cpf, ''), '\D', '', 'g') = v_cpf
  ) then
    return query select false, 'cpf_conflict', 'CPF em conflito com outra Pessoa.', v_email;
    return;
  end if;

  select count(*) into v_auth_count
  from auth.users au
  where lower(trim(coalesce(au.email, ''))) = v_email;
  if v_auth_count = 0 then
    return query select true, 'eligible', 'Cadastro apto para convite.', v_email;
    return;
  end if;
  if v_auth_count <> 1 then
    return query select false, 'email_conflict', 'E-mail em conflito com outra conta.', v_email;
    return;
  end if;
  select au.* into strict v_auth_user
  from auth.users au
  where lower(trim(coalesce(au.email, ''))) = v_email;

  select pai.* into v_inv
  from public.participant_account_invites pai
  where pai.registration_contact_id = v_contact.id
    and lower(trim(pai.email)) = v_email
    and pai.status = 'pending'
    and (
      pai.auth_user_id = v_auth_user.id
      or (pai.auth_user_id is null
        and v_auth_user.raw_user_meta_data->>'participant_invite_id' = pai.id::text)
    )
  order by pai.created_at desc
  limit 1;
  if not found then
    return query select false, 'email_conflict', 'E-mail em conflito com outra conta.', v_email;
    return;
  end if;

  select regexp_replace(coalesce(cp.cpf, ''), '\D', '', 'g') into v_profile_cpf
  from public.customer_profiles cp
  where cp.user_id = v_auth_user.id;
  if nullif(v_profile_cpf, '') is not null and v_profile_cpf <> v_cpf then
    return query select false, 'cpf_conflict', 'CPF em conflito com a conta deste e-mail.', v_email;
    return;
  end if;

  return query select true, 'resend_invite_existing_account', 'Convite pendente pode ser reenviado.', v_email;
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

  update public.participant_account_invites
  set status = 'revoked', updated_at = now()
  where registration_contact_id = v_contact.id
    and status = 'pending'
    and expires_at <= now();

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

create or replace function public.claim_registration_contact_account_invite(
  p_invite_id uuid
)
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

revoke all on function public.check_registration_contact_account_invite_eligibility(uuid) from public, anon, authenticated;
revoke all on function public.prepare_registration_contact_account_invite(uuid) from public, anon, authenticated;
revoke all on function public.claim_registration_contact_account_invite(uuid) from public, anon, authenticated;
grant execute on function public.check_registration_contact_account_invite_eligibility(uuid) to authenticated;
grant execute on function public.prepare_registration_contact_account_invite(uuid) to authenticated;
grant execute on function public.claim_registration_contact_account_invite(uuid) to authenticated;
grant execute on function public.check_registration_contact_account_invite_eligibility(uuid) to service_role;
grant execute on function public.prepare_registration_contact_account_invite(uuid) to service_role;
grant execute on function public.claim_registration_contact_account_invite(uuid) to service_role;
