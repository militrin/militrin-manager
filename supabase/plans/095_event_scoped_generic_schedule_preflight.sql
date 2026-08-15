-- 095_event_scoped_generic_schedule_preflight.sql
-- Somente leitura. Nao altera dados nem estrutura.

with metrics as (
  select
    to_regclass('public.kit_delivery_schedule') is not null as schedule_table_exists,
    (select count(*) from public.kit_delivery_schedule)::bigint as legacy_unscoped_schedule_rows,
    (select count(*) from information_schema.columns where table_schema='public' and table_name='kit_delivery_schedule' and column_name in('id','delivery_at','city','location','sort_order','is_active','created_at','updated_at'))::bigint as compatible_legacy_columns,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null as has_org_access_function,
    to_regprocedure('public.current_user_has_permission(text)') is not null as has_permission_function,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='tickets' and column_name='event_id') as tickets_have_event_id,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='tickets' and column_name='participant_id') as tickets_have_participant_id
), summary as (
  select *,array_remove(array[
    case when not schedule_table_exists then 'A tabela public.kit_delivery_schedule nao existe.' end,
    case when legacy_unscoped_schedule_rows>0 then legacy_unscoped_schedule_rows||' compromisso(s) global(is) legado(s) nao possuem event_id deterministico; classifique-os antes da migration.' end,
    case when compatible_legacy_columns<>8 then 'A estrutura legada do cronograma difere das 8 colunas esperadas pela migration.' end,
    case when not has_org_access_function then 'Funcao user_can_access_organization(uuid,uuid) ausente.' end,
    case when not has_permission_function then 'Funcao current_user_has_permission(text) ausente.' end,
    case when not tickets_have_event_id or not tickets_have_participant_id then 'Tickets nao possuem event_id/participant_id exigidos pelo isolamento do portal.' end
  ],null)::text[] as blocking_reasons
  from metrics
)
select cardinality(blocking_reasons)=0 as safe_to_apply,blocking_reasons,
  case when legacy_unscoped_schedule_rows=0 then array['Nenhum cronograma global precisara ser associado automaticamente.']::text[] else array[]::text[] end as non_blocking_notes,
  schedule_table_exists,legacy_unscoped_schedule_rows,compatible_legacy_columns,
  has_org_access_function,has_permission_function,tickets_have_event_id,tickets_have_participant_id
from summary;
