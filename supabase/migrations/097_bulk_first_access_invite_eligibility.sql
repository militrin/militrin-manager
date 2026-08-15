-- 097_bulk_first_access_invite_eligibility.sql
-- Delta posterior a 096: avaliacao canonica sem escrita e preparacao reutilizando a mesma regra.

begin;

create or replace function public.check_participant_account_invite_eligibility(p_participant_id uuid)
returns table(eligible boolean,reason_code text,reason_message text,email text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_email text; v_same_email integer;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao.'; end if;
  select * into v_p from public.participants where id=p_participant_id;
  if not found or not public.user_can_access_organization(v_actor,v_p.organization_id) then
    return query select false,'inaccessible','Cadastro invalido ou sem acesso.',null::text; return;
  end if;
  if v_p.user_id is not null then return query select false,'already_linked','Cadastro ja vinculado a uma conta.',null::text; return; end if;
  if nullif(trim(coalesce(v_p.email,'')),'') is null then return query select false,'missing_email','E-mail ausente.',null::text; return; end if;
  v_email:=lower(trim(v_p.email));
  if v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return query select false,'invalid_email','E-mail invalido.',v_email; return; end if;
  if not public.is_valid_cpf(v_p.cpf) then return query select false,'invalid_cpf','CPF invalido.',v_email; return; end if;
  select count(*) into v_same_email from public.participants
    where organization_id=v_p.organization_id and user_id is null and lower(trim(coalesce(email,'')))=v_email;
  if v_same_email<>1 then return query select false,'shared_email','E-mail compartilhado por mais de um cadastro.',v_email; return; end if;
  if exists(select 1 from auth.users au where lower(trim(coalesce(au.email,'')))=v_email) then
    return query select false,'existing_account','E-mail ja pertence a uma conta NEXORA.',v_email; return;
  end if;
  return query select true,'eligible','Cadastro apto para convite.',v_email;
end; $$;

create or replace function public.prepare_participant_account_invite(p_participant_id uuid)
returns table(invite_id uuid,email text) language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_email text; v_id uuid; v_check record;
begin
  select * into v_check from public.check_participant_account_invite_eligibility(p_participant_id);
  if not coalesce(v_check.eligible,false) then raise exception '%',coalesce(v_check.reason_message,'Cadastro nao elegivel.'); end if;
  select * into v_p from public.participants where id=p_participant_id for update;
  v_email:=v_check.email;
  update public.participant_account_invites set status='revoked',updated_at=now()
    where participant_id=v_p.id and status='pending' and expires_at<=now();
  insert into public.participant_account_invites(organization_id,event_id,participant_id,email,invited_by)
    values(v_p.organization_id,v_p.event_id,v_p.id,v_email,v_actor)
    on conflict(participant_id) where status='pending' do update set email=excluded.email,invited_by=excluded.invited_by,
      expires_at=now()+interval '7 days',updated_at=now() returning id into v_id;
  return query select v_id,v_email;
end; $$;

revoke all on function public.check_participant_account_invite_eligibility(uuid) from public,anon,authenticated;
revoke all on function public.prepare_participant_account_invite(uuid) from public,anon,authenticated;
grant execute on function public.check_participant_account_invite_eligibility(uuid) to authenticated;
grant execute on function public.prepare_participant_account_invite(uuid) to authenticated;

commit;
