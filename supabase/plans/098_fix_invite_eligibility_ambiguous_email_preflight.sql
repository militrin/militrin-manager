-- Somente leitura. Valida precondicoes da 098 sem avaliar cadastros ou alterar dados.
with
checks as (
  select
    to_regprocedure('public.check_participant_account_invite_eligibility(uuid)') is not null as has_eligibility_rpc,
    to_regprocedure('public.prepare_participant_account_invite(uuid)') is not null as has_prepare_rpc,
    to_regprocedure('public.current_user_has_permission(text)') is not null as has_permission_rpc,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null as has_organization_access_rpc,
    to_regprocedure('public.is_valid_cpf(text)') is not null as has_cpf_validator,
    to_regclass('public.participants') is not null as has_participants_table,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='id' and data_type='uuid') as has_participant_id,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='organization_id' and data_type='uuid') as has_participant_organization,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='user_id' and data_type='uuid') as has_participant_user,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='cpf' and data_type='text') as has_participant_cpf,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='email' and data_type='text') as has_participant_email,
    exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='id' and data_type='uuid') as has_auth_user_id,
    exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='email' and data_type in('text','character varying')) as has_auth_user_email
), signatures as (
  select count(*) filter(where p.proname='check_participant_account_invite_eligibility')::bigint as eligibility_overload_count,
    count(*) filter(where p.proname='prepare_participant_account_invite')::bigint as prepare_overload_count
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in('check_participant_account_invite_eligibility','prepare_participant_account_invite')
), sources as (
  select coalesce(pg_get_functiondef(to_regprocedure('public.check_participant_account_invite_eligibility(uuid)')),'') as eligibility_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.prepare_participant_account_invite(uuid)')),'') as prepare_definition
), metrics as (
  select checks.*,signatures.*,
    (select eligibility_definition ~* 'coalesce\([[:space:]]*email[[:space:]]*,' from sources) as has_unqualified_email_reference,
    (select prepare_definition ilike '%check_participant_account_invite_eligibility%' from sources) as prepare_uses_eligibility_rpc
  from checks cross join signatures
), summary as (
  select metrics.*,array_remove(array[
    case when not has_eligibility_rpc then 'RPC check_participant_account_invite_eligibility(uuid) da 097 ausente.' end,
    case when not has_prepare_rpc then 'RPC prepare_participant_account_invite(uuid) ausente.' end,
    case when not has_permission_rpc then 'RPC current_user_has_permission(text) ausente.' end,
    case when not has_organization_access_rpc then 'RPC user_can_access_organization(uuid,uuid) ausente.' end,
    case when not has_cpf_validator then 'RPC is_valid_cpf(text) ausente.' end,
    case when not has_participants_table or not has_participant_id or not has_participant_organization or not has_participant_user or not has_participant_cpf or not has_participant_email then 'Schema de participants incompatível com a função corrigida.' end,
    case when not has_auth_user_id or not has_auth_user_email then 'auth.users.id/email ausente ou incompatível.' end,
    case when eligibility_overload_count<>1 then eligibility_overload_count||' assinatura(s) encontradas para check_participant_account_invite_eligibility; esperado 1.' end,
    case when prepare_overload_count<>1 then prepare_overload_count||' assinatura(s) encontradas para prepare_participant_account_invite; esperado 1.' end,
    case when not prepare_uses_eligibility_rpc then 'prepare_participant_account_invite nao depende da elegibilidade canonica da 097.' end
  ],null)::text[] as blocking_reasons
  from metrics
)
select cardinality(blocking_reasons)=0 as safe_to_apply,blocking_reasons,
  has_eligibility_rpc,has_prepare_rpc,has_permission_rpc,has_organization_access_rpc,has_cpf_validator,
  has_participants_table,has_participant_id,has_participant_organization,has_participant_user,
  has_participant_cpf,has_participant_email,has_auth_user_id,has_auth_user_email,
  eligibility_overload_count,prepare_overload_count,prepare_uses_eligibility_rpc,
  has_unqualified_email_reference,
  pg_get_function_identity_arguments(to_regprocedure('public.check_participant_account_invite_eligibility(uuid)')) as eligibility_signature,
  pg_get_function_identity_arguments(to_regprocedure('public.prepare_participant_account_invite(uuid)')) as prepare_signature
from summary;
