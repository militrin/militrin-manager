-- 105_ticket_administrative_timeline_diagnostic.sql
-- Estritamente somente leitura: fontes comprovadas da linha do tempo do ingresso alvo.
with target as (
  select t.id ticket_id,t.event_id,t.organization_id,t.participant_id,t.order_id,t.order_item_id,t.issued_at,t.used_at,t.cancelled_at,
    o.payment_id,o.confirmed_at,pay.paid_at,pay.payment_status
  from public.tickets t
  left join public.orders o on o.id=t.order_id
  left join public.payments pay on pay.id=o.payment_id
  where t.id='86825375-30c1-4e82-83ac-be080b2b1a5c'::uuid
), kit_links as (
  select pki.id,pki.kit_item_id,pki.status,pki.delivered_at,pki.variant_data
  from target t join public.participant_kit_items pki on pki.ticket_id=t.ticket_id
), related_audit as (
  select al.id,al.action,al.entity_type,al.entity_id,al.event_id,al.details,al.created_at
  from target t join public.audit_logs al on al.event_id=t.event_id
  where al.entity_id in(t.ticket_id,t.participant_id,t.order_id,t.order_item_id,t.payment_id)
     or al.entity_id in(select id from kit_links)
), shirt_audit_resolution as (
  select
    al.id as audit_log_id,
    parsed.kit_item_id as audited_kit_item_id,
    parsed.variant_id as audited_variant_id,
    eki.id is not null and eki.item_type='shirt' and eki.is_active as kit_item_is_active_event_shirt,
    e.organization_id=t.organization_id as ticket_and_item_share_organization,
    v.id is not null and v.kit_item_id=eki.id as variant_belongs_to_audited_item,
    nullif(to_jsonb(eki)->>'shirt_supply_mode','') as installed_supply_mode,
    al.details->>'supply_mode' as audited_supply_mode,
    v.name as resolved_shirt_type,
    v.value as resolved_shirt_size
  from related_audit al
  join target t on t.ticket_id=al.entity_id and al.entity_type='tickets'
  cross join lateral (
    select
      case when coalesce(al.details->>'kit_item_id','')~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        then (al.details->>'kit_item_id')::uuid end as kit_item_id,
      case when coalesce(al.details->>'variant_id','')~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        then (al.details->>'variant_id')::uuid end as variant_id
  ) parsed
  left join public.event_kit_items eki on eki.id=parsed.kit_item_id and eki.event_id=t.event_id
  left join public.events e on e.id=eki.event_id
  left join public.event_kit_item_variants v on v.id=parsed.variant_id and v.kit_item_id=eki.id and v.is_active
  where al.action='ticket_shirt_admin_changed'
), source_catalog as (
  select table_name
  from information_schema.tables
  where table_schema='public' and table_name in(
    'audit_logs','ticket_holder_history','participant_kit_items','ticket_item_change_requests',
    'kit_deliveries','inventory_movements','participation_history','orders','payments','tickets'
  )
), functional_counts as (
  select
    (select count(*)::integer from related_audit where action='ticket_issued') ticket_issued_audit_count,
    (select count(*)::integer from related_audit where action in('payment_admin_confirmed','registration_payment_confirmed')) payment_confirmation_audit_count,
    0::integer as babylook_exg_direct_audit_count,
    (select count(distinct sar.audit_log_id)::integer from shirt_audit_resolution sar
      where sar.kit_item_is_active_event_shirt
        and sar.ticket_and_item_share_organization
        and sar.variant_belongs_to_audited_item
        and sar.resolved_shirt_type='Babylook'
        and sar.resolved_shirt_size='EXG'
        and sar.audited_supply_mode='made_to_order'
        and sar.installed_supply_mode=sar.audited_supply_mode) as babylook_exg_variant_audit_count,
    (select count(*)::integer from public.ticket_holder_history th join target t on t.ticket_id=th.ticket_id) holder_history_count,
    (select count(*)::integer from public.ticket_item_change_requests cr join target t on t.ticket_id=cr.ticket_id) item_change_history_count,
    (select count(*)::integer from related_audit where action like '%kit%') kit_audit_count,
    (select count(*)::integer from related_audit where action like '%checkin%') checkin_audit_count,
    (select count(*)::integer from related_audit where action like '%category%') category_audit_count,
    (select count(*)::integer from related_audit where action like '%resend%' or action like '%resent%') resend_audit_count,
    (select count(*)::integer from related_audit where action like '%cancel%') cancellation_audit_count
), active_function_audit as (
  select
    position('audit_logs' in lower(coalesce(pg_get_functiondef(to_regprocedure('public.admin_change_ticket_shirt(uuid,text,text)')),'')))>0 shirt_change_registers_audit,
    position('audit_logs' in lower(coalesce(pg_get_functiondef(to_regprocedure('public.checkin_ticket_entry(uuid)')),'')))>0 checkin_registers_audit,
    position('audit_logs' in lower(coalesce(pg_get_functiondef(to_regprocedure('public.undo_ticket_checkin(uuid)')),'')))>0 undo_checkin_registers_audit,
    position('audit_logs' in lower(coalesce(pg_get_functiondef(to_regprocedure('public.deliver_ticket_kit_item(uuid,uuid)')),'')))>0 kit_delivery_registers_audit,
    position('audit_logs' in lower(coalesce(pg_get_functiondef(to_regprocedure('public.admin_cancel_ticket(uuid,text)')),'')))>0 cancellation_registers_audit
)
select
  (select row_to_json(t) from target t) as ticket_state,
  (select coalesce(jsonb_agg(table_name order by table_name),'[]'::jsonb) from source_catalog) as available_history_and_audit_tables,
  (select coalesce(jsonb_agg(jsonb_build_object('id',id,'action',action,'entity_type',entity_type,'entity_id',entity_id,'created_at',created_at,
    'has_reason',nullif(details->>'reason','') is not null,'supply_mode',details->>'supply_mode','shirt_type',details->>'shirt_type','shirt_size',details->>'shirt_size')
    order by created_at,id),'[]'::jsonb) from related_audit) as proven_audit_events,
  (select coalesce(jsonb_agg(jsonb_build_object('id',id,'kit_item_id',kit_item_id,'status',status,'delivered_at',delivered_at,'variant_data',variant_data)
    order by id),'[]'::jsonb) from kit_links) as kit_functional_state,
  (select coalesce(jsonb_agg(to_jsonb(sar) order by sar.audit_log_id),'[]'::jsonb) from shirt_audit_resolution sar) as shirt_audit_resolution,
  fc.*,afa.*,
  (select issued_at is not null from target) as has_persisted_issuance_timestamp,
  (select coalesce(paid_at,confirmed_at) is not null from target) as has_persisted_payment_confirmation_timestamp,
  fc.babylook_exg_direct_audit_count>0 or fc.babylook_exg_variant_audit_count>0 as migration_104_babylook_exg_audit_exists,
  fc.ticket_issued_audit_count=0 and (select issued_at is not null from target) as issuance_exists_but_was_missing_from_audit_read,
  fc.payment_confirmation_audit_count=0 and (select coalesce(paid_at,confirmed_at) is not null from target) as payment_exists_but_was_missing_from_audit_read,
  fc.holder_history_count>0 as holder_history_was_outside_current_interface,
  fc.item_change_history_count>0 as item_change_history_was_outside_current_interface,
  fc.resend_audit_count=0 as resend_has_no_proven_audit_for_ticket,
  not afa.shirt_change_registers_audit or not afa.checkin_registers_audit or not afa.undo_checkin_registers_audit
    or not afa.kit_delivery_registers_audit as active_canonical_operation_without_audit_detected
from functional_counts fc cross join active_function_audit afa;
