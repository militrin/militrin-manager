-- 106_protected_admin_ticket_audit_timeline_preflight.sql
-- Estritamente somente leitura: valida o leitor protegido e a melhoria futura do payload.
with target as (
  select t.id ticket_id,t.event_id,t.organization_id,t.participant_id,t.order_item_id,t.order_id
  from public.tickets t where t.id='86825375-30c1-4e82-83ac-be080b2b1a5c'::uuid
), structure as (
  select to_regclass('public.audit_logs') is not null has_audit_logs,
    to_regclass('public.tickets') is not null has_tickets,
    to_regclass('public.order_items') is not null has_order_items,
    to_regclass('public.orders') is not null has_orders,
    to_regclass('public.participant_kit_items') is not null has_participant_kit_items,
    to_regprocedure('public.current_user_has_permission(text)') is not null has_permission_resolver,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null has_organization_guard,
    to_regprocedure('public.admin_change_ticket_shirt(uuid,text,text)') is not null has_shirt_operation
), definitions as (
  select coalesce(pg_get_functiondef(to_regprocedure('public.admin_change_ticket_shirt(uuid,text,text)')),'') shirt_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.get_admin_ticket_audit_timeline(uuid)')),'') reader_definition
), audit_state as (
  select count(*)::integer target_audit_count,
    count(*) filter(where al.action='ticket_issued')::integer ticket_issued_count,
    count(*) filter(where al.action='ticket_shirt_admin_changed')::integer shirt_change_count,
    count(distinct al.id) filter(where al.action='ticket_shirt_admin_changed')::integer distinct_shirt_change_count
  from target t join public.audit_logs al on al.event_id=t.event_id and al.entity_type='tickets' and al.entity_id=t.ticket_id
), variant_state as (
  select count(distinct parsed.variant_id)::integer resolved_historical_variant_count,
    count(*) filter(where v.id is null)::integer unresolved_historical_variant_count
  from target t join public.audit_logs al on al.event_id=t.event_id and al.entity_type='tickets' and al.entity_id=t.ticket_id
    and al.action='ticket_shirt_admin_changed'
  cross join lateral(select case when coalesce(al.details->>'variant_id','')~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    then (al.details->>'variant_id')::uuid end variant_id) parsed
  left join public.event_kit_item_variants v on v.id=parsed.variant_id
), compatibility as (
  select position('jsonb_build_object(''actor_user_id'',v_actor,''kit_item_id'',v_item.id,''variant_id'',v_variant.id,''supply_mode'',v_item.shirt_supply_mode)' in regexp_replace(lower(d.shirt_definition),'\s+','','g'))>0 shirt_payload_104_is_replaceable,
    position('previous_variant_id' in lower(d.shirt_definition))>0 and position('new_variant_id' in lower(d.shirt_definition))>0 future_variant_audit_installed,
    position('current_user_has_permission(''participants.view'')' in regexp_replace(lower(d.reader_definition),'\s+','','g'))>0
      and position('user_can_access_organization(v_actor,v_ticket.organization_id)' in regexp_replace(lower(d.reader_definition),'\s+','','g'))>0 protected_reader_installed
  from definitions d
)
select s.*,a.*,v.*,c.*,
  to_regprocedure('public.get_admin_ticket_audit_timeline(uuid)') is not null protected_reader_signature_installed,
  a.target_audit_count=3 and a.ticket_issued_count=1 and a.shirt_change_count=2
    and a.distinct_shirt_change_count=2 as target_has_three_proven_audit_rows,
  s.has_audit_logs and s.has_tickets and s.has_order_items and s.has_orders and s.has_participant_kit_items
    and s.has_permission_resolver and s.has_organization_guard and s.has_shirt_operation
    and a.target_audit_count=3 and a.ticket_issued_count=1 and a.shirt_change_count=2 and a.distinct_shirt_change_count=2
    and v.resolved_historical_variant_count=2 and v.unresolved_historical_variant_count=0
    and (c.shirt_payload_104_is_replaceable or c.future_variant_audit_installed)
    and (d.reader_definition='' or c.protected_reader_installed)
  as safe_to_apply
from structure s cross join definitions d cross join audit_state a cross join variant_state v cross join compatibility c;
