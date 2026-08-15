-- Somente leitura. Valida o delta da 097 sem preparar convites ou alterar dados.
-- Nao usa migration_096_recorded: a aplicacao da 096 e comprovada apenas pela baseline estrutural abaixo.
with
checks as (
  select
    to_regclass('public.participant_account_invites') is not null as has_invite_table,
    to_regprocedure('public.prepare_participant_account_invite(uuid)') is not null as has_prepare_rpc,
    to_regprocedure('public.claim_participant_account_invite(uuid)') is not null as has_claim_rpc,
    to_regprocedure('public.current_user_has_permission(text)') is not null as has_permission_rpc,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null as has_organization_access_rpc,
    to_regprocedure('public.is_valid_cpf(text)') is not null as has_cpf_validator,
    to_regprocedure('public.check_participant_account_invite_eligibility(uuid)') is not null as has_097_eligibility_rpc,
    exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='id' and data_type='uuid') as has_auth_user_id,
    exists(select 1 from information_schema.columns where table_schema='auth' and table_name='users' and column_name='email' and data_type in('text','character varying')) as has_auth_user_email,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='id' and data_type='uuid') as has_participant_id,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='organization_id' and data_type='uuid') as has_participant_organization,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='event_id' and data_type='uuid') as has_participant_event,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='user_id' and data_type='uuid') as has_participant_user,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='cpf' and data_type='text') as has_participant_cpf,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participants' and column_name='email' and data_type='text') as has_participant_email,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='participant_data_issues' and column_name='resolution_scope' and data_type='text' and is_nullable='NO') as has_resolution_scope_column,
    exists(select 1 from pg_constraint where conrelid=to_regclass('public.participant_data_issues') and contype='c'
      and pg_get_constraintdef(oid) ilike '%resolution_scope%' and pg_get_constraintdef(oid) ilike '%user_resolvable%' and pg_get_constraintdef(oid) ilike '%admin_only%') as has_resolution_scope_check,
    not exists(select 1 from (values
      ('id','uuid','NO'),('organization_id','uuid','NO'),('event_id','uuid','NO'),('participant_id','uuid','NO'),
      ('email','text','NO'),('status','text','NO'),('invited_by','uuid','NO'),('claimed_user_id','uuid','YES'),
      ('expires_at','timestamp with time zone','NO'),('claimed_at','timestamp with time zone','YES'),
      ('created_at','timestamp with time zone','NO'),('updated_at','timestamp with time zone','NO')
    ) expected(column_name,data_type,is_nullable)
    left join information_schema.columns c on c.table_schema='public' and c.table_name='participant_account_invites'
      and c.column_name=expected.column_name and c.data_type=expected.data_type and c.is_nullable=expected.is_nullable
    where c.column_name is null) as has_invite_columns,
    exists(select 1 from pg_constraint where conrelid=to_regclass('public.participant_account_invites') and contype='c'
      and pg_get_constraintdef(oid) ilike '%status%' and pg_get_constraintdef(oid) ilike '%pending%'
      and pg_get_constraintdef(oid) ilike '%claimed%' and pg_get_constraintdef(oid) ilike '%revoked%'
      and pg_get_constraintdef(oid) ilike '%expired%') as has_invite_status_check
), expected_pending_index as (
  select exists(select 1 from pg_indexes where schemaname='public' and tablename='participant_account_invites'
    and indexname='ux_participant_account_invites_pending' and indexdef ilike '%unique%'
    and indexdef ilike '%(participant_id)%' and indexdef ilike '%where%status%pending%') as compatible
), conflicting_indexes as (
  select indexname as relname,indexdef as definition from pg_indexes
  where schemaname='public' and tablename='participant_account_invites'
    and indexdef ilike '%unique%' and indexname<>'ux_participant_account_invites_pending'
    and indexdef ilike '%participant_id%'
), unexpected_signatures as (
  select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as signature
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in('prepare_participant_account_invite','check_participant_account_invite_eligibility')
    and not ((p.proname='prepare_participant_account_invite' and p.oid=to_regprocedure('public.prepare_participant_account_invite(uuid)'))
      or (p.proname='check_participant_account_invite_eligibility' and p.oid=to_regprocedure('public.check_participant_account_invite_eligibility(uuid)')))
), function_sources as (
  select coalesce(pg_get_functiondef(to_regprocedure('public.prepare_participant_account_invite(uuid)')),'') as prepare_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.claim_participant_account_invite(uuid)')),'') as claim_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.check_participant_account_invite_eligibility(uuid)')),'') as eligibility_definition
), metrics as (
  select checks.*,(select compatible from expected_pending_index) as has_compatible_pending_index,
    (select count(*) from conflicting_indexes)::bigint as conflicting_invite_indexes,
    (select count(*) from unexpected_signatures)::bigint as unexpected_function_signatures,
    (select prepare_definition ilike '%check_participant_account_invite_eligibility%' from function_sources) as prepare_uses_097_eligibility,
    (select prepare_definition ilike '%customer_profiles%email%' or prepare_definition ilike '%link_participation_history_by_cpf%'
      or claim_definition ilike '%customer_profiles%email%' or claim_definition ilike '%link_participation_history_by_cpf%'
      or eligibility_definition ilike '%customer_profiles%email%' or eligibility_definition ilike '%link_participation_history_by_cpf%' from function_sources) as has_unexpected_dependencies
  from checks
), summary as (
  select metrics.*,
    (has_invite_table and has_invite_columns and has_invite_status_check and has_prepare_rpc and has_claim_rpc
      and has_resolution_scope_column and has_resolution_scope_check and has_compatible_pending_index) as has_096_structural_baseline,
    array_remove(array[
      case when not has_invite_table then 'Tabela public.participant_account_invites da 096 ausente.' end,
      case when not has_invite_columns then 'Colunas de participant_account_invites ausentes ou incompatíveis.' end,
      case when not has_invite_status_check then 'Constraint de status de participant_account_invites ausente ou incompatível.' end,
      case when not has_prepare_rpc then 'RPC prepare_participant_account_invite(uuid) da 096 ausente.' end,
      case when not has_claim_rpc then 'RPC claim_participant_account_invite(uuid) da 096 ausente.' end,
      case when not has_resolution_scope_column then 'Coluna participant_data_issues.resolution_scope da 096 ausente ou incompatível.' end,
      case when not has_resolution_scope_check then 'Constraint de resolution_scope da 096 ausente ou incompatível.' end,
      case when not has_permission_rpc then 'RPC current_user_has_permission(text) ausente.' end,
      case when not has_organization_access_rpc then 'RPC user_can_access_organization(uuid,uuid) ausente.' end,
      case when not has_cpf_validator then 'RPC is_valid_cpf(text) ausente.' end,
      case when not has_auth_user_id or not has_auth_user_email then 'auth.users.id/email ausente ou incompatível.' end,
      case when not has_participant_id or not has_participant_organization or not has_participant_event or not has_participant_user or not has_participant_cpf or not has_participant_email then 'Schema de participants incompatível com a elegibilidade de convite.' end,
      case when not has_compatible_pending_index then 'Indice parcial unico ux_participant_account_invites_pending ausente ou incompatível.' end,
      case when conflicting_invite_indexes>0 then conflicting_invite_indexes||' indice(s) unico(s) adicional(is) sobre participant_id exigem revisao.' end,
      case when unexpected_function_signatures>0 then unexpected_function_signatures||' assinatura(s)/overload(s) inesperada(s) de convite.' end,
      case when has_097_eligibility_rpc is distinct from prepare_uses_097_eligibility then 'Delta 097 parcialmente presente: elegibilidade e prepare nao estao sincronizados.' end,
      case when has_unexpected_dependencies then 'Funcoes atuais possuem dependencia inesperada de customer_profiles.email ou vinculo legado por CPF.' end
    ],null)::text[] as blocking_reasons
  from metrics
)
select cardinality(blocking_reasons)=0 as safe_to_apply,blocking_reasons,
  has_096_structural_baseline,has_invite_table,has_invite_columns,has_invite_status_check,
  has_resolution_scope_column,has_resolution_scope_check,has_prepare_rpc,has_claim_rpc,
  has_097_eligibility_rpc,prepare_uses_097_eligibility,
  has_permission_rpc,has_organization_access_rpc,has_cpf_validator,
  has_auth_user_id,has_auth_user_email,has_participant_id,has_participant_organization,
  has_participant_event,has_participant_user,has_participant_cpf,has_participant_email,
  has_compatible_pending_index,conflicting_invite_indexes,unexpected_function_signatures,has_unexpected_dependencies,
  pg_get_function_identity_arguments(to_regprocedure('public.prepare_participant_account_invite(uuid)')) as prepare_signature,
  pg_get_function_identity_arguments(to_regprocedure('public.claim_participant_account_invite(uuid)')) as claim_signature,
  pg_get_function_identity_arguments(to_regprocedure('public.check_participant_account_invite_eligibility(uuid)')) as eligibility_signature,
  (select coalesce(jsonb_agg(to_jsonb(x) order by x.relname),'[]'::jsonb) from conflicting_indexes x) as conflicting_index_details,
  (select coalesce(jsonb_agg(to_jsonb(x) order by x.signature),'[]'::jsonb) from unexpected_signatures x) as unexpected_signature_details
from summary;
