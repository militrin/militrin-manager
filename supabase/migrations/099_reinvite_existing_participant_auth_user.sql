-- 099_reinvite_existing_participant_auth_user.sql
-- Correlacao persistente entre convite e usuario Auth para reenvio idempotente.

begin;

alter table public.participant_account_invites
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create index if not exists idx_participant_account_invites_auth_user
  on public.participant_account_invites(auth_user_id)
  where auth_user_id is not null;

-- Recupera somente a correlacao explicita gravada pelo envio anterior. E-mail
-- sozinho nunca e suficiente e ambiguidades permanecem sem vinculo.
update public.participant_account_invites pai
set auth_user_id=au.id,updated_at=now()
from auth.users au
where pai.auth_user_id is null
  and lower(trim(au.email))=lower(trim(pai.email))
  and au.raw_user_meta_data->>'participant_invite_id'=pai.id::text
  and not exists(
    select 1 from auth.users other
    where other.id<>au.id and lower(trim(other.email))=lower(trim(pai.email))
  );

create or replace function public.check_participant_account_invite_eligibility(p_participant_id uuid)
returns table(eligible boolean,reason_code text,reason_message text,email text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_email text; v_same_email integer;
  v_auth_count integer; v_auth_user auth.users%rowtype; v_inv public.participant_account_invites%rowtype;
  v_conflicting_participants integer; v_profile_cpf text;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao.'; end if;
  select p.* into v_p from public.participants p where p.id=p_participant_id;
  if not found or not public.user_can_access_organization(v_actor,v_p.organization_id) then
    return query select false,'inaccessible','Cadastro invalido ou sem acesso.',null::text; return;
  end if;
  if v_p.user_id is not null then return query select false,'already_linked','Cadastro ja vinculado a uma conta.',null::text; return; end if;
  if nullif(trim(coalesce(v_p.email,'')),'') is null then return query select false,'missing_email','E-mail ausente.',null::text; return; end if;
  v_email:=lower(trim(v_p.email));
  if v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return query select false,'invalid_email','E-mail invalido.',v_email; return; end if;
  if not public.is_valid_cpf(v_p.cpf) then return query select false,'invalid_cpf','CPF invalido.',v_email; return; end if;
  select count(*) into v_same_email from public.participants p
    where p.organization_id=v_p.organization_id and p.user_id is null
      and lower(trim(coalesce(p.email,'')))=v_email;
  if v_same_email<>1 then return query select false,'shared_email','E-mail compartilhado por mais de um cadastro.',v_email; return; end if;

  select count(*) into v_auth_count from auth.users au where lower(trim(coalesce(au.email,'')))=v_email;
  if v_auth_count=0 then return query select true,'eligible','Cadastro apto para convite.',v_email; return; end if;
  if v_auth_count<>1 then return query select false,'account_conflict','E-mail pertence a outra conta NEXORA.',v_email; return; end if;
  select au.* into strict v_auth_user from auth.users au where lower(trim(coalesce(au.email,'')))=v_email;

  select pai.* into v_inv from public.participant_account_invites pai
  where pai.participant_id=v_p.id and lower(trim(pai.email))=v_email
    and pai.status='pending'
    and (pai.auth_user_id=v_auth_user.id
      or (pai.auth_user_id is null and v_auth_user.raw_user_meta_data->>'participant_invite_id'=pai.id::text))
  order by pai.created_at desc limit 1;
  if not found then return query select false,'account_conflict','E-mail pertence a outra conta NEXORA.',v_email; return; end if;

  select count(*) into v_conflicting_participants from public.participants p
    where p.user_id=v_auth_user.id and p.id<>v_p.id;
  if v_conflicting_participants>0 then return query select false,'account_conflict','E-mail pertence a outra conta NEXORA.',v_email; return; end if;

  select regexp_replace(coalesce(cp.cpf,''),'\D','','g') into v_profile_cpf
  from public.customer_profiles cp where cp.user_id=v_auth_user.id;
  if nullif(v_profile_cpf,'') is not null
    and v_profile_cpf<>regexp_replace(coalesce(v_p.cpf,''),'\D','','g') then
    return query select false,'account_conflict','E-mail pertence a outra conta NEXORA.',v_email; return;
  end if;

  if nullif(v_auth_user.encrypted_password,'') is null then
    return query select true,'resend_invite_password_required','Convite pode ser reenviado para concluir o primeiro acesso.',v_email;
  else
    return query select true,'resend_invite_existing_account','Conta existente validada pelo convite; enviar acesso seguro para reivindicar o cadastro.',v_email;
  end if;
end; $$;

revoke all on function public.check_participant_account_invite_eligibility(uuid) from public,anon,authenticated;
grant execute on function public.check_participant_account_invite_eligibility(uuid) to authenticated;

commit;
