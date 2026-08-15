-- Somente leitura. Valida o delta da 099 sem enviar convites ou alterar dados.
with checks as (
  select
    to_regclass('public.participant_account_invites') is not null as has_invite_table,
    to_regprocedure('public.check_participant_account_invite_eligibility(uuid)') is not null as has_eligibility_rpc,
    to_regprocedure('public.prepare_participant_account_invite(uuid)') is not null as has_prepare_rpc,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participant_account_invites' and column_name='participant_id' and data_type='uuid') as has_invite_participant,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participant_account_invites' and column_name='email' and data_type='text') as has_invite_email,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participant_account_invites' and column_name='status' and data_type='text') as has_invite_status,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participant_account_invites' and column_name='auth_user_id' and data_type='uuid') as delta_auth_user_column_already_present,
    exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='id' and data_type='uuid') as has_auth_id,
    exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='email') as has_auth_email,
    exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='encrypted_password') as has_auth_password,
    exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='raw_user_meta_data' and data_type='jsonb') as has_auth_metadata,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='customer_profiles' and column_name='user_id' and data_type='uuid') as has_profile_user,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='customer_profiles' and column_name='cpf' and data_type='text') as has_profile_cpf
), conflicts as (
  select count(*)::bigint as ambiguous_legacy_correlations
  from public.participant_account_invites pai
  where exists(select 1 from auth.users au where lower(trim(au.email))=lower(trim(pai.email)) and au.raw_user_meta_data->>'participant_invite_id'=pai.id::text)
    and 1<>(select count(*) from auth.users au where lower(trim(au.email))=lower(trim(pai.email)))
), summary as (
  select checks.*,conflicts.*,
    array_remove(array[
      case when not has_invite_table then 'Tabela participant_account_invites da 096 ausente.' end,
      case when not has_eligibility_rpc or not has_prepare_rpc then 'RPCs canonicas de convite da 097/098 ausentes.' end,
      case when not has_invite_participant or not has_invite_email or not has_invite_status then 'Estrutura base de participant_account_invites incompativel.' end,
      case when not has_auth_id or not has_auth_email or not has_auth_password or not has_auth_metadata then 'auth.users incompativel com a correlacao segura da 099.' end,
      case when not has_profile_user or not has_profile_cpf then 'customer_profiles.user_id/cpf ausente ou incompativel.' end,
      case when ambiguous_legacy_correlations>0 then ambiguous_legacy_correlations||' correlacao(oes) legada(s) ambiguas exigem revisao; nao serao vinculadas automaticamente.' end
    ],null)::text[] as blocking_reasons
  from checks cross join conflicts
)
select cardinality(blocking_reasons)=0 as safe_to_apply,blocking_reasons,
  has_invite_table,has_eligibility_rpc,has_prepare_rpc,has_invite_participant,has_invite_email,has_invite_status,
  delta_auth_user_column_already_present,has_auth_id,has_auth_email,has_auth_password,has_auth_metadata,
  has_profile_user,has_profile_cpf,ambiguous_legacy_correlations,
  pg_get_function_identity_arguments(to_regprocedure('public.check_participant_account_invite_eligibility(uuid)')) as eligibility_signature,
  pg_get_function_identity_arguments(to_regprocedure('public.prepare_participant_account_invite(uuid)')) as prepare_signature
from summary;
