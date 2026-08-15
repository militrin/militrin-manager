-- 098_fix_invite_eligibility_ambiguous_email.sql
-- Qualifica colunas da elegibilidade para evitar conflito com parametros de saida PL/pgSQL.

begin;

create or replace function public.check_participant_account_invite_eligibility(p_participant_id uuid)
returns table(eligible boolean,reason_code text,reason_message text,email text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_p public.participants%rowtype; v_email text; v_same_email integer;
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
  if exists(select 1 from auth.users au where lower(trim(coalesce(au.email,'')))=v_email) then
    return query select false,'existing_account','E-mail ja pertence a uma conta NEXORA.',v_email; return;
  end if;
  return query select true,'eligible','Cadastro apto para convite.',v_email;
end; $$;

revoke all on function public.check_participant_account_invite_eligibility(uuid) from public,anon,authenticated;
grant execute on function public.check_participant_account_invite_eligibility(uuid) to authenticated;

commit;
