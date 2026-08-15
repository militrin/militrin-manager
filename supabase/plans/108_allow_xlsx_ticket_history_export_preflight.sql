-- 108_allow_xlsx_ticket_history_export_preflight.sql
-- Estritamente somente leitura: valida a extensao XLSX antes ou depois da migration 108.
with structure as (
  select
    to_regclass('public.audit_logs') is not null as has_audit_logs,
    to_regclass('public.tickets') is not null as has_tickets,
    to_regclass('public.events') is not null as has_events,
    to_regclass('public.admin_permissions') is not null as has_admin_permissions,
    to_regprocedure('public.current_user_has_permission(text)') is not null as has_permission_resolver,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null as has_organization_guard
), required_columns as (
  select
    count(*) filter(where table_name='audit_logs' and column_name in('id','action','entity_type','entity_id','event_id','details','created_at'))=7 as audit_logs_structure_ok,
    count(*) filter(where table_name='tickets' and column_name in('id','event_id','organization_id'))=3 as tickets_structure_ok,
    count(*) filter(where table_name='events' and column_name in('id','organization_id'))=2 as events_structure_ok
  from information_schema.columns
  where table_schema='public' and table_name in('audit_logs','tickets','events')
), permissions_state as (
  select
    exists(select 1 from public.admin_permissions ap where ap.code='participants.view' and coalesce((to_jsonb(ap)->>'is_active')::boolean,true)) as has_participants_view,
    exists(select 1 from public.admin_permissions ap where ap.code='orders.view' and coalesce((to_jsonb(ap)->>'is_active')::boolean,true)) as has_orders_view,
    exists(select 1 from public.admin_permissions ap where ap.code='audit.view' and coalesce((to_jsonb(ap)->>'is_active')::boolean,true)) as has_audit_view
), signature_state as (
  select
    to_regprocedure('public.record_ticket_history_export(uuid,text,text,date,date,text,uuid)') is not null as expected_signature_exists,
    count(*) filter(where p.proname='record_ticket_history_export'
      and p.oid<>coalesce(to_regprocedure('public.record_ticket_history_export(uuid,text,text,date,date,text,uuid)')::oid,'0'::oid))::integer as conflicting_signature_count
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
), active_definition as (
  select coalesce(pg_get_functiondef(to_regprocedure('public.record_ticket_history_export(uuid,text,text,date,date,text,uuid)')),'') as body
), audit as (
  select
    position('security definer' in lower(body))>0 as is_security_definer,
    position('auth.uid()' in lower(body))>0 as uses_authenticated_actor,
    position('current_user_has_permission' in lower(body))>0 as validates_rbac,
    position('user_can_access_organization' in lower(body))>0 as validates_organization,
    position('ticket_history_exported' in lower(body))>0 as records_canonical_action,
    position('''actor_user_id'',v_actor' in regexp_replace(lower(body),'\s+','','g'))>0 as records_actor_in_payload,
    position('xlsx' in lower(body))>0 as xlsx_format_already_installed,
    position('audit_logs(id,actor,' in regexp_replace(lower(body),'\s+','','g'))>0
      or lower(body)~'audit_logs\s*\.\s*actor\M' as references_missing_audit_actor,
    position('service_role' in lower(body))>0 as references_service_role
  from active_definition
)
select s.*,rc.*,p.*,ss.*,a.*,
  s.has_audit_logs and s.has_tickets and s.has_events and s.has_admin_permissions
    and s.has_permission_resolver and s.has_organization_guard
    and rc.audit_logs_structure_ok and rc.tickets_structure_ok and rc.events_structure_ok
    and p.has_participants_view and p.has_orders_view and p.has_audit_view
    and ss.expected_signature_exists and ss.conflicting_signature_count=0
    and a.is_security_definer and a.uses_authenticated_actor and a.validates_rbac
    and a.validates_organization and a.records_canonical_action and a.records_actor_in_payload
    and not a.references_missing_audit_actor and not a.references_service_role
  as safe_to_apply
from structure s cross join required_columns rc cross join permissions_state p
cross join signature_state ss cross join audit a;
