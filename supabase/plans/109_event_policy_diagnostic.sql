-- 109_event_policy_diagnostic.sql
-- Estritamente somente leitura: diagnostica a politica ativa de eventos.
with definitions as (
  select
    coalesce(pg_get_functiondef(to_regprocedure('public.create_event(text,text,integer,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,boolean,boolean,boolean,uuid)')),'') create_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.update_event(uuid,text,text,integer,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,boolean,boolean,boolean)')),'') update_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.set_event_active(uuid)')),'') activate_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.set_event_registration_enabled(uuid,boolean)')),'') sales_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.archive_event(uuid)')),'') archive_definition
), event_counts as (
  select count(*)::integer event_count,
    count(*) filter(where is_active)::integer active_event_count,
    count(*) filter(where registration_enabled)::integer registration_enabled_count,
    count(*) filter(where is_active and registration_enabled)::integer active_with_sales_count,
    count(*) filter(where not is_active and registration_enabled)::integer inactive_with_sales_count,
    count(*) filter(where organization_id is null)::integer events_without_organization_count
  from public.events
), catalog as (
  select
    coalesce(jsonb_agg(jsonb_build_object('column',column_name,'type',data_type,'nullable',is_nullable)
      order by ordinal_position),'[]'::jsonb) event_columns
  from information_schema.columns where table_schema='public' and table_name='events'
), indexes as (
  select coalesce(jsonb_agg(jsonb_build_object('name',indexname,'definition',indexdef) order by indexname),'[]'::jsonb) event_indexes,
    bool_or(indexname='ux_events_single_active' and indexdef ilike '%where (is_active = true)%') legacy_single_active_index_detected
  from pg_indexes where schemaname='public' and tablename='events'
), triggers as (
  select coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid)) order by t.tgname),'[]'::jsonb) event_triggers
  from pg_trigger t where t.tgrelid='public.events'::regclass and not t.tgisinternal
), grants as (
  select coalesce(jsonb_agg(jsonb_build_object('function',routine_name,'grantee',grantee,'privilege',privilege_type)
    order by routine_name,grantee),'[]'::jsonb) event_function_grants
  from information_schema.routine_privileges
  where routine_schema='public' and routine_name in('create_event','update_event','set_event_active','set_event_registration_enabled','archive_event')
), related as (
  select coalesce(jsonb_object_agg(name,present),'{}'::jsonb) related_configuration_tables
  from (values
    ('registration_batches',to_regclass('public.registration_batches') is not null),
    ('ticket_categories',to_regclass('public.ticket_categories') is not null),
    ('event_kit_items',to_regclass('public.event_kit_items') is not null),
    ('event_payment_methods',to_regclass('public.event_payment_methods') is not null),
    ('event_highlights',to_regclass('public.event_highlights') is not null),
    ('event_schedule_items',to_regclass('public.event_schedule_items') is not null),
    ('import_batches',to_regclass('public.import_batches') is not null)
  ) x(name,present)
)
select ec.*,c.event_columns,i.event_indexes,t.event_triggers,g.event_function_grants,r.related_configuration_tables,
  coalesce(i.legacy_single_active_index_detected,false) legacy_single_active_index_detected,
  position('updatepublic.events' in regexp_replace(lower(d.create_definition),'\s+','','g'))>0
    and position('setis_active=false' in regexp_replace(lower(d.create_definition),'\s+','','g'))>0
    and position('whereis_active=true' in regexp_replace(lower(d.create_definition),'\s+','','g'))>0
    as create_event_globally_deactivates_others,
  position('set is_active = false' in lower(d.update_definition||d.activate_definition))>0 activation_functions_deactivate_others,
  position('registration_enabled = false' in lower(d.archive_definition))>0 archive_closes_sales,
  not exists(select 1 from information_schema.columns where table_schema='public' and table_name='events'
    and column_name in('archived_at','archived_by','archive_status')) archive_has_no_explicit_state,
  not coalesce(i.legacy_single_active_index_detected,false)
    and position('set is_active = false' in lower(d.create_definition||d.update_definition||d.activate_definition))=0
    as multiple_active_policy_is_safe
from definitions d cross join event_counts ec cross join catalog c cross join indexes i
cross join triggers t cross join grants g cross join related r;
