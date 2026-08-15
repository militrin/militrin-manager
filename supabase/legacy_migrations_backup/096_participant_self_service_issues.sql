-- 096_participant_self_service_issues.sql
-- Convite explicito por projection, escopo de pendencia e resolucao pelo proprio titular.

begin;

alter table public.participant_data_issues
  add column if not exists resolution_scope text not null default 'admin_only';
alter table public.participant_data_issues drop constraint if exists participant_data_issues_resolution_scope_check;
alter table public.participant_data_issues add constraint participant_data_issues_resolution_scope_check
  check(resolution_scope in('user_resolvable','admin_only'));

update public.participant_data_issues set resolution_scope=case
  when field_code in('cpf','birth_date','gender','phone','email','city','shirt_type','shirt_size','shirt_selection')
    then 'user_resolvable'
  else 'admin_only'
end;

create table if not exists public.participant_account_invites(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  email text not null,
  status text not null default 'pending' check(status in('pending','claimed','revoked','expired')),
  invited_by uuid not null references auth.users(id) on delete restrict,
  claimed_user_id uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null default(now()+interval '7 days'),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ux_participant_account_invites_pending
  on public.participant_account_invites(participant_id) where status='pending';
create index if not exists idx_participant_account_invites_email
  on public.participant_account_invites(lower(email),status,expires_at);
alter table public.participant_account_invites enable row level security;
create policy participant_account_invites_admin_select on public.participant_account_invites for select to authenticated
  using(public.user_can_access_organization(auth.uid(),organization_id)
    and public.current_user_has_permission('participants.view'));
revoke all on public.participant_account_invites from public,anon,authenticated;
grant select on public.participant_account_invites to authenticated;

create or replace function public.prepare_participant_account_invite(p_participant_id uuid)
returns table(invite_id uuid,email text) language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_email text; v_id uuid; v_same_email integer;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao.'; end if;
  select * into v_p from public.participants where id=p_participant_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_p.organization_id) then raise exception 'Cadastro invalido ou sem acesso.'; end if;
  if v_p.user_id is not null then raise exception 'Cadastro ja vinculado a uma conta.'; end if;
  if not public.is_valid_cpf(v_p.cpf) then raise exception 'CPF valido obrigatorio antes do convite.'; end if;
  v_email:=lower(nullif(trim(coalesce(v_p.email,'')),''));
  if v_email is null or v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'E-mail valido obrigatorio antes do convite.'; end if;
  select count(*) into v_same_email from public.participants
    where organization_id=v_p.organization_id and user_id is null and lower(trim(coalesce(email,'')))=v_email;
  if v_same_email<>1 then raise exception 'E-mail compartilhado por mais de um cadastro; corrija o e-mail individual antes de convidar.'; end if;
  if exists(select 1 from auth.users au where lower(trim(coalesce(au.email,'')))=v_email) then
    raise exception 'E-mail ja pertence a uma conta NEXORA; use vinculacao explicita com validacao de identidade.';
  end if;
  update public.participant_account_invites set status='revoked',updated_at=now()
    where participant_id=v_p.id and status='pending' and expires_at<=now();
  insert into public.participant_account_invites(organization_id,event_id,participant_id,email,invited_by)
    values(v_p.organization_id,v_p.event_id,v_p.id,v_email,v_actor)
    on conflict(participant_id) where status='pending' do update set email=excluded.email,invited_by=excluded.invited_by,
      expires_at=now()+interval '7 days',updated_at=now() returning id into v_id;
  return query select v_id,v_email;
end; $$;

create or replace function public.claim_participant_account_invite(p_invite_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_auth_email text; v_inv public.participant_account_invites%rowtype; v_p public.participants%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select lower(trim(email)) into v_auth_email from auth.users where id=v_actor;
  select * into v_inv from public.participant_account_invites where id=p_invite_id for update;
  if not found or v_inv.status<>'pending' or v_inv.expires_at<=now() then raise exception 'Convite invalido ou expirado.'; end if;
  if v_auth_email is distinct from lower(trim(v_inv.email)) then raise exception 'O convite nao pertence a esta conta.'; end if;
  select * into v_p from public.participants where id=v_inv.participant_id for update;
  if not found or (v_p.user_id is not null and v_p.user_id<>v_actor) then raise exception 'Cadastro ja vinculado a outra conta.'; end if;
  update public.participants set user_id=v_actor,updated_at=now() where id=v_p.id;
  update public.participation_history set user_id=v_actor,updated_at=now()
    where participant_id=v_p.id and (user_id is null or user_id=v_actor);
  update public.participant_account_invites set status='claimed',claimed_user_id=v_actor,claimed_at=now(),updated_at=now() where id=v_inv.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('participant_account_invite_claimed','participants',v_p.id,v_p.event_id,jsonb_build_object('invite_id',v_inv.id,'user_id',v_actor));
  return v_p.id;
end; $$;

-- Mantem um unico motor: amplia os RPCs existentes apenas para o titular da projection.
do $migration$
declare v_definition text;
begin
  select pg_get_functiondef('public.resolve_participant_data_issues(uuid,uuid[],jsonb)'::regprocedure) into v_definition;
  if position('if not (' in lower(v_definition))=0 or position('public.resolve_user_permission' in v_definition)=0 then
    raise exception 'Assinatura/corpo inesperado de resolve_participant_data_issues.';
  end if;
  v_definition:=replace(v_definition,
    $$if not (
    public.is_active_owner(v_actor)
    or public.resolve_user_permission(v_actor, 'participants.edit_basic')
  ) then
    raise exception 'Usuario sem permissao para resolver pendencias.';
  end if;$$,
    $$perform 1;$$);
  v_definition:=replace(v_definition,
    $$if v_organization_id is null
    or not public.user_can_access_organization(v_actor, v_organization_id) then
    raise exception 'Usuario sem acesso a organizacao do participante.';
  end if;$$,
    $$if v_organization_id is null or not (
      v_participant.user_id=v_actor
      or (public.user_can_access_organization(v_actor,v_organization_id)
        and (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'participants.edit_basic')))
    ) then raise exception 'Usuario sem acesso ao cadastro.'; end if;$$);
  if v_definition not like '%v_participant.user_id=v_actor%' then raise exception 'Nao foi possivel aplicar autorizacao do titular ao resolvedor.'; end if;
  execute v_definition;

  select pg_get_functiondef('public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)'::regprocedure) into v_definition;
  v_definition:=replace(v_definition,
    $$if not public.user_can_access_organization(v_actor,v_participant.organization_id) then raise exception 'Usuario sem acesso ao participante.'; end if;$$,
    $$if v_actor is distinct from v_participant.user_id and not public.user_can_access_organization(v_actor,v_participant.organization_id) then raise exception 'Usuario sem acesso ao cadastro.'; end if;$$);
  if v_definition not like '%v_actor is distinct from v_participant.user_id%' then raise exception 'Nao foi possivel aplicar autorizacao do titular a finalizacao.'; end if;
  execute v_definition;
end $migration$;

revoke all on function public.prepare_participant_account_invite(uuid) from public,anon,authenticated;
revoke all on function public.claim_participant_account_invite(uuid) from public,anon,authenticated;
grant execute on function public.prepare_participant_account_invite(uuid) to authenticated;
grant execute on function public.claim_participant_account_invite(uuid) to authenticated;

commit;
