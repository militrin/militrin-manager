-- 109_multi_active_event_policy_preflight.sql
-- Estritamente somente leitura: aceita o estado legado esperado e o estado idempotente da migration 109.
with structure as (
  select to_regclass('public.events') is not null has_events,
    to_regclass('public.admin_permissions') is not null has_admin_permissions,
    to_regprocedure('public.current_user_has_permission(text)') is not null has_permission_resolver,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null has_organization_guard,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='events' and column_name='organization_id' and data_type='uuid') has_event_organization,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='import_batches' and column_name='event_id' and data_type='uuid') import_persists_event_id
), archive_columns as (
  select exists(select 1 from information_schema.columns where table_schema='public' and table_name='events' and column_name='archived_at' and data_type='timestamp with time zone') has_archived_at,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='events' and column_name='archived_by' and data_type='uuid') has_archived_by,
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='events' and column_name='archived_at') explicit_archive_state_exists
), definitions as (
  select coalesce(pg_get_functiondef(to_regprocedure('public.create_event(text,text,integer,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,boolean,boolean,boolean,uuid)')),'') create_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.update_event(uuid,text,text,integer,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,boolean,boolean,boolean)')),'') update_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.set_event_active(uuid)')),'') activate_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.set_event_inactive(uuid)')),'') deactivate_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.set_event_registration_enabled(uuid,boolean)')),'') sales_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.archive_event(uuid)')),'') archive_body,
    coalesce(pg_get_functiondef(to_regprocedure('public.restore_event(uuid)')),'') restore_body
), function_state as (
  select
    (position('updatepublic.eventssetis_active=false' in regexp_replace(lower(create_body),'\s+','','g'))>0) legacy_create_deactivates_others,
    (position('whereis_active=trueandid<>p_event_id' in regexp_replace(lower(update_body||activate_body),'\s+','','g'))>0) legacy_activation_deactivates_others,
    position('current_user_has_permission(''events.edit'')' in regexp_replace(lower(create_body||update_body),'\s+','','g'))>0 installed_edit_rbac,
    position('current_user_has_permission(''events.publish'')' in regexp_replace(lower(activate_body||deactivate_body||sales_body),'\s+','','g'))>0 installed_publish_rbac,
    position('current_user_has_permission(''events.archive'')' in regexp_replace(lower(archive_body||restore_body),'\s+','','g'))>0 installed_archive_rbac,
    position('user_can_access_organization' in lower(create_body||update_body||activate_body||deactivate_body||sales_body||archive_body||restore_body))>0 installed_organization_guards,
    position('event_restored' in lower(restore_body))>0 and position('registration_enabled=false' in regexp_replace(lower(restore_body),'\s+','','g'))>0 installed_restore_contract
  from definitions
), blockers as (
  select exists(select 1 from pg_indexes where schemaname='public' and tablename='events' and indexname='ux_events_single_active') legacy_single_active_index_exists,
    count(*) filter(where lower(pg_get_functiondef(p.oid)) like '%update public.events%set is_active = false%where is_active = true%')::integer functions_that_deactivate_other_events,
    count(*) filter(where lower(pg_get_functiondef(p.oid)) like '%from public.events%is_active%limit 1%')::integer database_implicit_event_selector_count,
    count(*) filter(where lower(pg_get_functiondef(p.oid)) like '%from public.events%is_active%limit 1%')::integer active_event_limit_one_function_count
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
), integrity as (
  select count(*) filter(where organization_id is null)::integer events_without_organization_count,
    count(*) filter(where nullif(to_jsonb(events)->>'archived_at','') is not null and (is_active or registration_enabled))::integer invalid_archived_state_count,
    count(*) filter(where not is_active and registration_enabled)::integer inactive_events_with_open_sales_count
  from public.events
), relation_ambiguities as (
  select
    (select count(*) from public.participants p where not exists(select 1 from public.events e where e.id=p.event_id and e.organization_id=p.organization_id))::integer participant_event_mismatch_count,
    (select count(*) from public.orders o where not exists(select 1 from public.events e where e.id=o.event_id and e.organization_id=o.organization_id))::integer order_event_mismatch_count,
    (select count(*) from public.tickets t where not exists(select 1 from public.events e where e.id=t.event_id and e.organization_id=t.organization_id))::integer ticket_event_mismatch_count,
    (select count(*) from public.registration_batches b where not exists(select 1 from public.events e where e.id=b.event_id))::integer batch_event_mismatch_count
), permissions as (
  select exists(select 1 from public.admin_permissions where code='events.edit' and coalesce((to_jsonb(admin_permissions)->>'is_active')::boolean,true)) has_events_edit,
    exists(select 1 from public.admin_permissions where code='events.publish' and coalesce((to_jsonb(admin_permissions)->>'is_active')::boolean,true)) has_events_publish,
    exists(select 1 from public.admin_permissions where code='events.archive' and coalesce((to_jsonb(admin_permissions)->>'is_active')::boolean,true)) has_events_archive
), anon_grants as (
  select count(*)::integer anonymous_admin_event_rpc_grant_count from information_schema.routine_privileges
  where routine_schema='public' and grantee in('anon','PUBLIC') and privilege_type='EXECUTE'
    and routine_name in('create_event','update_event','set_event_active','set_event_inactive','set_event_registration_enabled','archive_event','restore_event',
      'upsert_event_kit_item','delete_event_kit_item','upsert_event_kit_item_variant','delete_event_kit_item_variant',
      'duplicate_event_configuration','upsert_event_highlight','remove_event_highlight','upsert_event_payment_methods',
      'upsert_event_addons_config','upsert_event_addons_model','upsert_event_addon_option','delete_event_addon_option',
      'upsert_event_batch_addon_option','set_event_shirt_stock_limit','reset_event_shirt_inventory',
      'set_event_participant_item_changes','set_event_kit_item_change_rules','set_event_kit_item_variant_stock',
      'set_event_ticket_holder_rules','upsert_event_schedule_item','delete_event_schedule_item')
)
select s.*,ac.*,fs.*,b.*,i.*,ra.*,p.*,ag.*,
  (fs.legacy_create_deactivates_others and fs.legacy_activation_deactivates_others and b.legacy_single_active_index_exists) legacy_state_supported,
  (ac.has_archived_at and ac.has_archived_by and not b.legacy_single_active_index_exists
    and b.functions_that_deactivate_other_events=0 and fs.installed_edit_rbac and fs.installed_publish_rbac
    and fs.installed_archive_rbac and fs.installed_organization_guards and fs.installed_restore_contract
    and ag.anonymous_admin_event_rpc_grant_count=0) migration_109_idempotent_state,
  s.has_events and s.has_admin_permissions and s.has_permission_resolver and s.has_organization_guard
    and s.has_event_organization and s.import_persists_event_id and i.events_without_organization_count=0
    and ra.participant_event_mismatch_count=0 and ra.order_event_mismatch_count=0
    and ra.ticket_event_mismatch_count=0 and ra.batch_event_mismatch_count=0
    and p.has_events_edit and p.has_events_publish and p.has_events_archive
    and i.invalid_archived_state_count=0
    and ((fs.legacy_create_deactivates_others and fs.legacy_activation_deactivates_others and b.legacy_single_active_index_exists)
      or (ac.has_archived_at and ac.has_archived_by and not b.legacy_single_active_index_exists
        and b.functions_that_deactivate_other_events=0 and fs.installed_edit_rbac and fs.installed_publish_rbac
        and fs.installed_archive_rbac and fs.installed_organization_guards and fs.installed_restore_contract
        and ag.anonymous_admin_event_rpc_grant_count=0))
    as safe_to_apply
from structure s cross join archive_columns ac cross join definitions d cross join function_state fs
cross join blockers b cross join integrity i cross join relation_ambiguities ra cross join permissions p cross join anon_grants ag;
