-- First access: Cadastro unlinked + Auth existente da MESMA pessoa.
-- Nao auto-vincula por e-mail. Nao transfere ingresso.
-- Nao depende da Central V2. Pode entrar imediatamente apos 20261102.
--
-- Causa Leila: find_conflicting trata o proprio Cadastro importado
-- (user_id null + direitos protegidos) como "outra conta" quando o
-- convite pendente nao tem auth_user_id, mesmo com metadata
-- participant_invite_id apontando para o convite.
--
-- Materializacao de owner_user_id permanece a RPC canonica
-- materialize_intended_ticket_owners_for_contact (20261009):
-- so preenche owner nulo cujo intended_owner_contact_id e o Cadastro
-- reivindicado. Nao substitui owner preenchido. Nao escreve ticket aqui.

begin;

create or replace function public.registration_contact_invite_authorizes_user(
  p_contact_id uuid,
  p_user_id uuid,
  p_allow_pending boolean
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if p_contact_id is null or p_user_id is null then
    return false;
  end if;

  select organization_id into v_org
    from public.registration_contacts
    where id = p_contact_id;
  if v_org is null then
    return false;
  end if;

  return exists (
    select 1
    from public.participant_account_invites i
    join auth.users u on u.id = p_user_id
    where i.organization_id = v_org
      and (
        i.registration_contact_id = p_contact_id
        or i.participant_id in (
          select p.id
          from public.participants p
          where p.registration_contact_id = p_contact_id
        )
      )
      and lower(trim(coalesce(i.email, ''))) = lower(trim(coalesce(u.email, '')))
      and (
        (i.status = 'claimed' and i.claimed_user_id = p_user_id)
        or (
          p_allow_pending
          and i.status = 'pending'
          and i.expires_at > now()
          and (
            i.auth_user_id = p_user_id
            or (
              i.auth_user_id is null
              and u.raw_user_meta_data->>'participant_invite_id' is not null
              and u.raw_user_meta_data->>'participant_invite_id' = i.id::text
            )
          )
          and not exists (
            select 1
            from public.registration_contacts other
            where other.organization_id = v_org
              and other.user_id = p_user_id
              and other.id is distinct from p_contact_id
          )
          and not exists (
            select 1
            from public.registration_contacts sibling
            where sibling.organization_id = v_org
              and sibling.id is distinct from p_contact_id
              and nullif(lower(trim(coalesce(sibling.email, ''))), '') is not null
              and lower(trim(sibling.email)) = lower(trim(coalesce(u.email, '')))
          )
        )
      )
  );
end;
$$;

revoke all on function public.registration_contact_invite_authorizes_user(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

comment on function public.registration_contact_invite_authorizes_user(uuid, uuid, boolean) is
  'Autoriza claim/ensure do Cadastro apenas pelo convite da mesma Pessoa. Nao casa so por e-mail ou CPF.';

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
    perform public.materialize_intended_ticket_owners_for_contact(v_contact.id, v_actor);
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

commit;
