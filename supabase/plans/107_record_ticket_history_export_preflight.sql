-- 107_record_ticket_history_export_preflight.sql
-- Estritamente somente leitura: estrutura, RBAC e compatibilidade da migration 107.
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
), permission_catalog as (
  select
    exists(select 1 from public.admin_permissions ap where ap.code='participants.view' and coalesce((to_jsonb(ap)->>'is_active')::boolean,true)) as has_participants_view,
    exists(select 1 from public.admin_permissions ap where ap.code='orders.view' and coalesce((to_jsonb(ap)->>'is_active')::boolean,true)) as has_orders_view,
    exists(select 1 from public.admin_permissions ap where ap.code='audit.view' and coalesce((to_jsonb(ap)->>'is_active')::boolean,true)) as has_audit_view
), signature_state as (
  select
    to_regprocedure('public.record_ticket_history_export(uuid,text,text,date,date,text,uuid)') is not null as expected_signature_installed,
    count(*) filter(where p.proname='record_ticket_history_export'
      and p.oid<>coalesce(to_regprocedure('public.record_ticket_history_export(uuid,text,text,date,date,text,uuid)')::oid,'0'::oid))::integer as conflicting_signature_count
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
), definition as (
  select coalesce(pg_get_functiondef(to_regprocedure('public.record_ticket_history_export(uuid,text,text,date,date,text,uuid)')),'') as body
), function_audit as (
  select
    position('audit_logs(id,actor,' in regexp_replace(lower(d.body),'\s+','','g'))>0
      or lower(d.body)~'audit_logs\s*\.\s*actor\M' as installed_function_references_audit_logs_actor,
    d.body<>'' and position('''actor_user_id'',v_actor' in regexp_replace(lower(d.body),'\s+','','g'))>0
      as installed_payload_uses_actor_user_id
  from definition d
), compatibility as (
  select d.body='' or (
    position('security definer' in lower(d.body))>0
    and position('set search_path to ''public'', ''pg_temp''' in lower(d.body))>0
    and position('auth.uid()' in lower(d.body))>0
    and position('current_user_has_permission(''participants.view'')' in regexp_replace(lower(d.body),'\s+','','g'))>0
    and position('current_user_has_permission(''orders.view'')' in regexp_replace(lower(d.body),'\s+','','g'))>0
    and position('current_user_has_permission(''audit.view'')' in regexp_replace(lower(d.body),'\s+','','g'))>0
    and position('user_can_access_organization(v_actor,v_ticket.organization_id)' in regexp_replace(lower(d.body),'\s+','','g'))>0
    and position('ticket_history_exported' in lower(d.body))>0
    and position('''actor_user_id'',v_actor' in regexp_replace(lower(d.body),'\s+','','g'))>0
    and not fa.installed_function_references_audit_logs_actor
    and position('service_role' in lower(d.body))=0
  ) as signature_is_installable
  from definition d cross join function_audit fa
)
select s.*,rc.*,pc.*,ss.*,fa.*,c.signature_is_installable,
  s.has_audit_logs and s.has_tickets and s.has_events and s.has_admin_permissions
    and s.has_permission_resolver and s.has_organization_guard
    and rc.audit_logs_structure_ok and rc.tickets_structure_ok and rc.events_structure_ok
    and pc.has_participants_view and pc.has_orders_view and pc.has_audit_view
    and ss.conflicting_signature_count=0
    and not fa.installed_function_references_audit_logs_actor
    and c.signature_is_installable
  as safe_to_apply
from structure s cross join required_columns rc cross join permission_catalog pc
cross join signature_state ss cross join function_audit fa cross join compatibility c;
