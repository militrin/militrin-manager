-- Somente leitura. Nao envia convite e nao altera dados.
with checks as (
  select
    to_regprocedure('public.resolve_participant_data_issues(uuid,uuid[],jsonb)') is not null as has_resolver,
    to_regprocedure('public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)') is not null as has_finalizer,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='user_id') as has_participant_user,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participant_data_issues' and column_name='field_code') as has_issue_field,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='customer_profiles' and column_name='user_id' and data_type='uuid') as has_customer_profile_user_id,
    exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='id' and data_type='uuid') as has_auth_user_id,
    exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='email' and data_type in('text','character varying')) as has_auth_user_email
), incompatibilities as (
  select * from (values
    ('public.customer_profiles','user_id','uuid',(select has_customer_profile_user_id from checks)),
    ('auth.users','id','uuid',(select has_auth_user_id from checks)),
    ('auth.users','email','text/character varying',(select has_auth_user_email from checks))
  ) as expected(relation,column_name,expected_type,is_compatible)
  where not is_compatible
), risks as (
  select
    (select count(*) from public.participants where user_id is null and nullif(trim(coalesce(email,'')),'') is not null
      and not public.is_valid_cpf(cpf)) as invite_candidates_without_valid_cpf,
    (select count(*) from (select organization_id,lower(trim(email)) from public.participants where user_id is null and nullif(trim(coalesce(email,'')),'') is not null group by organization_id,lower(trim(email)) having count(*)>1) x) as shared_email_groups,
    (select count(*) from public.participants p join auth.users au on lower(trim(au.email))=lower(trim(p.email))
      where p.user_id is null and nullif(trim(coalesce(p.email,'')),'') is not null) as existing_account_email_conflicts
), summary as (
  select checks.*,risks.*,
    coalesce((select jsonb_agg(jsonb_build_object(
      'relation',relation,'column',column_name,'expected_type',expected_type,'status','missing_or_incompatible'
    ) order by relation,column_name) from incompatibilities),'[]'::jsonb) as schema_incompatibilities,
    array_remove(array[
      case when not has_customer_profile_user_id then 'public.customer_profiles.user_id uuid ausente ou incompatível.' end,
      case when not has_auth_user_id then 'auth.users.id uuid ausente ou incompatível.' end,
      case when not has_auth_user_email then 'auth.users.email textual ausente ou incompatível.' end,
      case when not has_resolver then 'RPC resolve_participant_data_issues(uuid,uuid[],jsonb) ausente.' end,
      case when not has_finalizer then 'RPC finalize_imported_participant_after_issue_resolution(uuid,text[],boolean) ausente.' end,
      case when not has_participant_user then 'public.participants.user_id ausente.' end,
      case when not has_issue_field then 'public.participant_data_issues.field_code ausente.' end
    ],null)::text[] as blocking_reasons
  from checks cross join risks
)
select cardinality(blocking_reasons)=0 as safe_to_prepare,
  blocking_reasons,schema_incompatibilities,
  has_resolver,has_finalizer,has_participant_user,has_issue_field,
  has_customer_profile_user_id,has_auth_user_id,has_auth_user_email,
  invite_candidates_without_valid_cpf,shared_email_groups,existing_account_email_conflicts,
  pg_get_function_identity_arguments(to_regprocedure('public.resolve_participant_data_issues(uuid,uuid[],jsonb)')) as resolver_signature,
  pg_get_function_identity_arguments(to_regprocedure('public.finalize_imported_participant_after_issue_resolution(uuid,text[],boolean)')) as finalizer_signature
from summary;
