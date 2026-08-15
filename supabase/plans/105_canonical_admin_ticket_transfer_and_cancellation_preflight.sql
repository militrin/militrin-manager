-- 105_canonical_admin_ticket_transfer_and_cancellation_preflight.sql
-- Estritamente somente leitura: dependencias, contratos e ambiguidades da migration 105.
with structure as (
  select
    to_regclass('public.tickets') is not null as has_tickets,
    to_regclass('public.order_items') is not null as has_order_items,
    to_regclass('public.orders') is not null as has_orders,
    to_regclass('public.payments') is not null as has_payments,
    to_regclass('public.participants') is not null as has_participants,
    to_regclass('public.participant_kit_items') is not null as has_participant_kit_items,
    to_regclass('public.event_kit_items') is not null as has_event_kit_items,
    to_regclass('public.event_kit_item_variant_inventory') is not null as has_variant_inventory,
    to_regclass('public.ticket_holder_history') is not null as has_holder_history,
    to_regclass('public.audit_logs') is not null as has_audit_logs,
    to_regclass('public.admin_permissions') is not null as has_admin_permissions,
    to_regprocedure('public.resolve_user_permission(uuid,text)') is not null as has_permission_resolver_base,
    to_regprocedure('public.current_user_has_permission(text)') is not null as has_permission_resolver,
    to_regprocedure('public.user_can_access_organization(uuid,uuid)') is not null as has_organization_guard,
    to_regprocedure('public.admin_transfer_ticket_by_pin(uuid,text,text,text)') is not null as has_legacy_pin_transfer,
    to_regprocedure('public.checkin_ticket_entry(uuid)') is not null as has_checkin,
    to_regprocedure('public.deliver_ticket_kit_item(uuid,uuid)') is not null as has_kit_delivery
), definitions as (
  select
    coalesce(pg_get_functiondef(to_regprocedure('public.checkin_ticket_entry(uuid)')),'') as checkin_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.deliver_ticket_kit_item(uuid,uuid)')),'') as delivery_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.search_admin_ticket_holder_candidates(uuid,text)')),'') as search_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.admin_transfer_ticket_holder(uuid,uuid,text)')),'') as transfer_definition,
    coalesce(pg_get_functiondef(to_regprocedure('public.admin_cancel_ticket(uuid,text)')),'') as cancel_definition
), constraints_state as (
  select
    exists(select 1 from pg_constraint where conrelid='public.tickets'::regclass and contype='c' and pg_get_constraintdef(oid) like '%cancelled%') as tickets_accept_cancelled,
    exists(select 1 from pg_constraint where conrelid='public.participant_kit_items'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%reserved%' and pg_get_constraintdef(oid) like '%confirmed%'
      and pg_get_constraintdef(oid) like '%delivered%' and pg_get_constraintdef(oid) like '%cancelled%') as kit_status_contract_ok,
    exists(select 1 from pg_indexes where schemaname='public' and tablename='participant_kit_items'
      and indexdef ilike '%unique%' and indexdef ilike '%ticket_id%' and indexdef ilike '%kit_item_id%') as has_ticket_kit_uniqueness
), permission_catalog_structure as (
  select
    exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='admin_permissions' and column_name='code') as has_admin_permissions_code,
    exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='admin_permissions' and column_name='is_active') as has_admin_permissions_is_active
), permissions_state as (
  select
    exists(select 1 from public.admin_permissions ap where ap.code='participants.edit_basic'
      and (not pcs.has_admin_permissions_is_active or coalesce((to_jsonb(ap)->>'is_active')::boolean,false))) as has_transfer_permission,
    exists(select 1 from public.admin_permissions ap where ap.code='orders.cancel'
      and (not pcs.has_admin_permissions_is_active or coalesce((to_jsonb(ap)->>'is_active')::boolean,false))) as has_cancel_permission,
    exists(select 1 from public.admin_permissions ap where ap.code='kits.deliver'
      and (not pcs.has_admin_permissions_is_active or coalesce((to_jsonb(ap)->>'is_active')::boolean,false))) as has_delivery_permission
  from permission_catalog_structure pcs
), signature_collisions as (
  select
    count(*) filter(where p.proname='search_admin_ticket_holder_candidates'
      and p.oid<>coalesce(to_regprocedure('public.search_admin_ticket_holder_candidates(uuid,text)')::oid,'0'::oid))::integer as search_signature_collision_count,
    count(*) filter(where p.proname='admin_transfer_ticket_holder'
      and p.oid<>coalesce(to_regprocedure('public.admin_transfer_ticket_holder(uuid,uuid,text)')::oid,'0'::oid))::integer as transfer_signature_collision_count,
    count(*) filter(where p.proname='admin_cancel_ticket'
      and p.oid<>coalesce(to_regprocedure('public.admin_cancel_ticket(uuid,text)')::oid,'0'::oid))::integer as cancel_signature_collision_count
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
), trigger_state as (
  select count(*) filter(where not t.tgisinternal and (
    t.tgrelid='public.tickets'::regclass or t.tgrelid='public.order_items'::regclass
    or t.tgrelid='public.participant_kit_items'::regclass
  ))::integer as relevant_noninternal_trigger_count
  from pg_trigger t
), ambiguities as (
  select
    (select count(*)::integer from (select ticket_id,kit_item_id from public.participant_kit_items
      where ticket_id is not null group by ticket_id,kit_item_id having count(*)>1) x) as ambiguous_ticket_kit_link_count,
    (select count(*)::integer from public.participant_kit_items pki join public.tickets t on t.id=pki.ticket_id
      where pki.order_item_id is distinct from t.order_item_id) as mismatched_ticket_order_item_kit_count,
    (select count(*)::integer from public.participant_kit_items pki join public.tickets t on t.id=pki.ticket_id
      where pki.participant_id is distinct from t.participant_id) as mismatched_ticket_participant_kit_count,
    (select count(*)::integer from public.event_kit_item_variant_inventory
      where reserved_quantity<0 or delivered_quantity<0 or reserved_quantity+delivered_quantity>total_quantity) as invalid_variant_inventory_count
), installed as (
  select
    position('length(v_term)<3' in regexp_replace(lower(search_definition),'\s+','','g'))>0 as search_105_installed,
    position('p_target_participant_id' in transfer_definition)>0
      and position('participant_kit_items' in transfer_definition)>0 as transfer_105_installed,
    position('admin_ticket_cancelled' in cancel_definition)>0
      and position('status=''cancelled''' in regexp_replace(lower(cancel_definition),'\s+','','g'))>0 as cancel_105_installed,
    position('ingressocanceladonaopermiteentregadekit' in regexp_replace(lower(delivery_definition),'[^a-z0-9]+','','g'))>0 as cancelled_delivery_guard_installed
  from definitions
), install_compatibility as (
  select
    (d.search_definition='' or i.search_105_installed) as search_signature_is_installable,
    (d.transfer_definition='' or i.transfer_105_installed) as transfer_signature_is_installable,
    (d.cancel_definition='' or i.cancel_105_installed) as cancel_signature_is_installable
  from definitions d cross join installed i
)
select s.*,pcs.*,c.*,p.*,sc.*,ts.*,a.*,i.*,ic.*,
  position('status=''cancelled''' in regexp_replace(lower(d.checkin_definition),'\s+','','g'))>0 as checkin_rejects_cancelled,
  position('reserved_quantity' in lower(d.delivery_definition))>0 as delivery_uses_canonical_reservation_inventory,
  (position('current_user_has_permission(''kits.deliver'')' in regexp_replace(lower(d.delivery_definition),'\s+','','g'))>0
    and position('v_item.shirt_supply_mode=''stock''' in regexp_replace(lower(d.delivery_definition),'\s+','','g'))>0
    and position('reserved_quantity=reserved_quantity-v_link.quantity' in regexp_replace(lower(d.delivery_definition),'\s+','','g'))>0
    and position('ticket_kit_item_delivered' in lower(d.delivery_definition))>0) as delivery_body_matches_expected_104,
  (i.search_105_installed and i.transfer_105_installed and i.cancel_105_installed and i.cancelled_delivery_guard_installed) as migration_105_idempotent_state,
  s.has_tickets and s.has_order_items and s.has_orders and s.has_payments and s.has_participants
    and s.has_participant_kit_items and s.has_event_kit_items and s.has_variant_inventory
    and s.has_holder_history and s.has_audit_logs and s.has_admin_permissions
    and s.has_permission_resolver_base and s.has_permission_resolver and s.has_organization_guard
    and s.has_legacy_pin_transfer and s.has_checkin and s.has_kit_delivery
    and c.tickets_accept_cancelled and c.kit_status_contract_ok and c.has_ticket_kit_uniqueness
    and pcs.has_admin_permissions_code
    and p.has_transfer_permission and p.has_cancel_permission and p.has_delivery_permission
    and position('status=''cancelled''' in regexp_replace(lower(d.checkin_definition),'\s+','','g'))>0
    and position('reserved_quantity' in lower(d.delivery_definition))>0
    and position('current_user_has_permission(''kits.deliver'')' in regexp_replace(lower(d.delivery_definition),'\s+','','g'))>0
    and position('v_item.shirt_supply_mode=''stock''' in regexp_replace(lower(d.delivery_definition),'\s+','','g'))>0
    and position('reserved_quantity=reserved_quantity-v_link.quantity' in regexp_replace(lower(d.delivery_definition),'\s+','','g'))>0
    and position('ticket_kit_item_delivered' in lower(d.delivery_definition))>0
    and sc.search_signature_collision_count=0 and sc.transfer_signature_collision_count=0 and sc.cancel_signature_collision_count=0
    and ic.search_signature_is_installable and ic.transfer_signature_is_installable and ic.cancel_signature_is_installable
    and a.ambiguous_ticket_kit_link_count=0 and a.mismatched_ticket_order_item_kit_count=0
    and a.mismatched_ticket_participant_kit_count=0 and a.invalid_variant_inventory_count=0
  as safe_to_apply
from structure s cross join definitions d cross join permission_catalog_structure pcs
cross join constraints_state c cross join permissions_state p
cross join signature_collisions sc cross join trigger_state ts cross join ambiguities a cross join installed i
cross join install_compatibility ic;
