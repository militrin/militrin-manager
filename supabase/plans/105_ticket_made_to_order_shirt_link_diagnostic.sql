-- 105_ticket_made_to_order_shirt_link_diagnostic.sql
-- Estritamente somente leitura: valida a camiseta sob encomenda vinculada ao ingresso informado.
with expected as (
  select
    '86825375-30c1-4e82-83ac-be080b2b1a5c'::uuid as ticket_id,
    'Babylook'::text as shirt_type,
    'EXG'::text as shirt_size,
    'made_to_order'::text as supply_mode
), target as (
  select
    t.id as ticket_id,t.status as ticket_status,t.participant_id,t.order_item_id,t.event_id,t.organization_id,
    p.full_name as participant_name,p.event_id as participant_event_id,p.organization_id as participant_organization_id,
    oi.order_id,oi.participant_id as order_item_participant_id,oi.event_id as order_item_event_id,
    oi.shirt_type as order_item_shirt_type,oi.shirt_size as order_item_shirt_size,
    e.name as event_name,o.name as organization_name
  from expected x
  left join public.tickets t on t.id=x.ticket_id
  left join public.participants p on p.id=t.participant_id
  left join public.order_items oi on oi.id=t.order_item_id
  left join public.events e on e.id=t.event_id
  left join public.organizations o on o.id=t.organization_id
), active_shirt_items as (
  select
    eki.id as kit_item_id,
    eki.event_id as kit_item_event_id,
    eki.name as kit_item_name,
    eki.item_type,
    eki.is_active,
    nullif(to_jsonb(eki)->>'shirt_supply_mode','') as installed_supply_mode
  from target t
  join public.event_kit_items eki on eki.event_id=t.event_id
  where eki.item_type='shirt' and eki.is_active
), expected_variants as (
  select
    v.id as variant_id,
    v.kit_item_id as variant_kit_item_id,
    v.name as variant_name,
    v.value as variant_value,
    v.is_active as variant_is_active
  from expected x
  join active_shirt_items eki on true
  join public.event_kit_item_variants v on v.kit_item_id=eki.kit_item_id
    and v.is_active and v.name=x.shirt_type and v.value=x.shirt_size
), shirt_links as (
  select
    pki.id as participant_kit_item_id,
    pki.ticket_id as linked_ticket_id,
    pki.participant_id as linked_participant_id,
    pki.order_item_id as linked_order_item_id,
    pki.event_id as linked_event_id,
    pki.organization_id as linked_organization_id,
    pki.kit_item_id as linked_kit_item_id,
    pki.variant_data,
    pki.status as participant_kit_item_status,
    pki.delivered_at,
    pki.quantity as linked_quantity
  from target t
  join active_shirt_items eki on true
  join public.participant_kit_items pki on pki.ticket_id=t.ticket_id and pki.kit_item_id=eki.kit_item_id
), shirt_item_choice as (
  select
    (array_agg(kit_item_id order by kit_item_id))[1] as shirt_kit_item_id,
    (array_agg(kit_item_name order by kit_item_id))[1] as shirt_kit_item_name,
    (array_agg(installed_supply_mode order by kit_item_id))[1] as installed_supply_mode
  from active_shirt_items
), variant_choice as (
  select (array_agg(variant_id order by variant_id))[1] as expected_variant_id from expected_variants
), shirt_link_choice as (
  select
    (array_agg(participant_kit_item_id order by participant_kit_item_id))[1] as participant_kit_item_id,
    (array_agg(linked_ticket_id order by participant_kit_item_id))[1] as linked_ticket_id,
    (array_agg(linked_participant_id order by participant_kit_item_id))[1] as linked_participant_id,
    (array_agg(linked_order_item_id order by participant_kit_item_id))[1] as linked_order_item_id,
    (array_agg(linked_event_id order by participant_kit_item_id))[1] as linked_event_id,
    (array_agg(linked_organization_id order by participant_kit_item_id))[1] as linked_organization_id,
    (array_agg(linked_kit_item_id order by participant_kit_item_id))[1] as linked_kit_item_id,
    (array_agg(variant_data order by participant_kit_item_id))[1] as variant_data,
    (array_agg(participant_kit_item_status order by participant_kit_item_id))[1] as participant_kit_item_status,
    (array_agg(delivered_at order by participant_kit_item_id))[1] as delivered_at,
    (array_agg(linked_quantity order by participant_kit_item_id))[1] as linked_quantity
  from shirt_links
), kit_counts as (
  select
    (select count(*)::integer from public.event_kit_items eki join target t on t.event_id=eki.event_id where eki.is_active) as active_kit_item_count,
    (select count(*)::integer from public.participant_kit_items pki join target t on t.ticket_id=pki.ticket_id) as ticket_kit_link_count,
    (select count(*)::integer from public.participant_kit_items pki join target t on t.ticket_id=pki.ticket_id where pki.status='delivered') as delivered_kit_link_count,
    (select count(*)::integer from active_shirt_items) as active_shirt_item_count,
    (select count(*)::integer from expected_variants) as expected_variant_count,
    (select count(*)::integer from shirt_links) as matching_shirt_link_count
), variant_stock as (
  select
    count(inv.id)::integer as variant_inventory_record_count,
    coalesce(sum(inv.total_quantity),0)::integer as variant_total_quantity,
    coalesce(sum(inv.reserved_quantity),0)::integer as variant_reserved_quantity,
    coalesce(sum(inv.delivered_quantity),0)::integer as variant_delivered_quantity
  from expected_variants v
  left join public.event_kit_item_variant_inventory inv on inv.kit_item_id=v.variant_kit_item_id and inv.variant_id=v.variant_id
), legacy_stock as (
  select
    count(si.id)::integer as legacy_inventory_record_count,
    coalesce(sum(si.total_quantity),0)::integer as legacy_total_quantity,
    coalesce(sum(si.reserved_quantity),0)::integer as legacy_reserved_quantity,
    coalesce(sum(si.delivered_quantity),0)::integer as legacy_delivered_quantity,
    coalesce(sum((select count(*) from public.inventory_movements im where im.inventory_id=si.id)),0)::integer as legacy_movement_count
  from target t cross join expected x
  left join public.shirt_inventory si on si.event_id=t.event_id and si.shirt_type=x.shirt_type and si.shirt_size=x.shirt_size
), movement_contract as (
  select
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='inventory_movements' and column_name='ticket_id')
      or exists(select 1 from information_schema.columns where table_schema='public' and table_name='inventory_movements' and column_name='participant_kit_item_id')
      as movement_correlation_supported,
    coalesce(pg_get_functiondef(to_regprocedure('public.admin_change_ticket_shirt(uuid,text,text)')),'') as shirt_change_definition
), operation_audit as (
  select count(*)::integer as matching_operation_audit_count,max(al.created_at) as latest_operation_at
  from target t cross join expected x
  join active_shirt_items eki on true
  join expected_variants v on v.variant_kit_item_id=eki.kit_item_id
  join public.audit_logs al on al.entity_type='tickets' and al.entity_id=t.ticket_id
    and al.action='ticket_shirt_admin_changed'
    and al.details->>'kit_item_id'=eki.kit_item_id::text
    and al.details->>'variant_id'=v.variant_id::text
    and al.details->>'supply_mode'=x.supply_mode
), resolved as (
  select
    t.ticket_id,t.ticket_status,t.participant_id,t.order_item_id,t.event_id,t.organization_id,
    t.participant_name,t.participant_event_id,t.participant_organization_id,t.order_id,
    t.order_item_participant_id,t.order_item_event_id,t.order_item_shirt_type,t.order_item_shirt_size,
    t.event_name,t.organization_name,
    x.ticket_id as expected_ticket_id,x.shirt_type,x.shirt_size,x.supply_mode,
    sic.shirt_kit_item_id,sic.shirt_kit_item_name,sic.installed_supply_mode,
    vc.expected_variant_id,slc.participant_kit_item_id,slc.linked_ticket_id,slc.linked_participant_id,slc.linked_order_item_id,
    slc.linked_event_id,slc.linked_organization_id,slc.linked_kit_item_id,slc.variant_data,
    slc.participant_kit_item_status,slc.delivered_at,slc.linked_quantity,
    kc.active_kit_item_count,kc.ticket_kit_link_count,kc.delivered_kit_link_count,
    kc.active_shirt_item_count,kc.expected_variant_count,kc.matching_shirt_link_count,
    vs.variant_inventory_record_count,vs.variant_total_quantity,vs.variant_reserved_quantity,vs.variant_delivered_quantity,
    ls.legacy_inventory_record_count,ls.legacy_total_quantity,ls.legacy_reserved_quantity,
    ls.legacy_delivered_quantity,ls.legacy_movement_count,
    mc.movement_correlation_supported,oa.matching_operation_audit_count,oa.latest_operation_at,
    position('ifv_item.shirt_supply_mode=''stock''then' in regexp_replace(lower(mc.shirt_change_definition),'\s+','','g'))>0
      and position('ifv_item.shirt_supply_mode=''made_to_order''then' in regexp_replace(lower(mc.shirt_change_definition),'\s+','','g'))=0
      as canonical_function_reserves_stock_only_in_stock_mode
  from expected x cross join target t cross join kit_counts kc cross join variant_stock vs cross join legacy_stock ls
  cross join movement_contract mc cross join operation_audit oa
  cross join shirt_item_choice sic cross join variant_choice vc cross join shirt_link_choice slc
)
select
  r.expected_ticket_id,r.ticket_id,r.ticket_status,r.participant_id,r.participant_name,r.participant_event_id,r.participant_organization_id,
  r.order_item_id,r.order_id,r.order_item_participant_id,r.order_item_event_id,
  r.event_id,r.event_name,r.organization_id,r.organization_name,
  r.order_item_shirt_type,r.order_item_shirt_size,
  r.shirt_kit_item_id,r.shirt_kit_item_name,r.installed_supply_mode,r.expected_variant_id,
  r.participant_kit_item_id,r.linked_ticket_id,r.linked_participant_id,r.linked_order_item_id,r.linked_event_id,r.linked_organization_id,r.linked_kit_item_id,
  r.variant_data,r.participant_kit_item_status,r.delivered_at,r.linked_quantity,
  r.active_kit_item_count,r.ticket_kit_link_count,r.delivered_kit_link_count,
  r.active_shirt_item_count,r.expected_variant_count,r.matching_shirt_link_count,
  r.variant_inventory_record_count>0 as variant_inventory_exists_for_babylook_exg,
  r.variant_total_quantity,r.variant_reserved_quantity,r.variant_delivered_quantity,
  r.legacy_inventory_record_count>0 as legacy_inventory_exists_for_babylook_exg,
  r.legacy_total_quantity,r.legacy_reserved_quantity,r.legacy_delivered_quantity,
  r.movement_correlation_supported,
  case when r.movement_correlation_supported then r.legacy_movement_count else null end as associated_inventory_movement_count,
  r.legacy_movement_count as unscoped_legacy_variant_movement_count,
  r.matching_operation_audit_count,r.latest_operation_at,
  r.ticket_id is not null and r.participant_id is not null and r.order_item_id is not null
    and r.ticket_id=r.expected_ticket_id and r.linked_ticket_id=r.ticket_id
    and r.active_shirt_item_count=1 and r.expected_variant_count=1 and r.matching_shirt_link_count=1
    and r.order_item_shirt_type=r.shirt_type and r.order_item_shirt_size=r.shirt_size
    and r.participant_event_id=r.event_id and r.participant_organization_id=r.organization_id
    and r.order_item_participant_id=r.participant_id and r.order_item_event_id=r.event_id
    and r.linked_participant_id=r.participant_id and r.linked_order_item_id=r.order_item_id
    and r.linked_event_id=r.event_id and r.linked_organization_id=r.organization_id
    and r.linked_kit_item_id=r.shirt_kit_item_id
    and r.variant_data->>'variant_id'=r.expected_variant_id::text
    and r.variant_data->>'shirt_type'=r.shirt_type and r.variant_data->>'shirt_size'=r.shirt_size
    and r.participant_kit_item_id is not null
    as shirt_synced,
  r.active_kit_item_count=4 and r.ticket_kit_link_count=4 as kit_has_four_items,
  r.participant_kit_item_status is distinct from 'delivered' and r.delivered_at is null as shirt_not_delivered,
  r.installed_supply_mode=r.supply_mode
    and r.canonical_function_reserves_stock_only_in_stock_mode
    and not r.movement_correlation_supported
    and r.matching_operation_audit_count>0
    as made_to_order_did_not_reserve_stock,
  r.ticket_id is not null and r.participant_id is not null and r.order_item_id is not null
    and r.ticket_id=r.expected_ticket_id and r.linked_ticket_id=r.ticket_id
    and r.event_id is not null and r.organization_id is not null
    and r.active_shirt_item_count=1 and r.expected_variant_count=1 and r.matching_shirt_link_count=1
    and r.order_item_shirt_type=r.shirt_type and r.order_item_shirt_size=r.shirt_size
    and r.participant_event_id=r.event_id and r.participant_organization_id=r.organization_id
    and r.order_item_participant_id=r.participant_id and r.order_item_event_id=r.event_id
    and r.linked_participant_id=r.participant_id and r.linked_order_item_id=r.order_item_id
    and r.linked_event_id=r.event_id and r.linked_organization_id=r.organization_id
    and r.linked_kit_item_id=r.shirt_kit_item_id
    and r.variant_data->>'variant_id'=r.expected_variant_id::text
    and r.variant_data->>'shirt_type'=r.shirt_type and r.variant_data->>'shirt_size'=r.shirt_size
    and r.active_kit_item_count=4 and r.ticket_kit_link_count=4
    and r.participant_kit_item_status is distinct from 'delivered' and r.delivered_at is null
    and r.installed_supply_mode=r.supply_mode
    and r.canonical_function_reserves_stock_only_in_stock_mode
    and not r.movement_correlation_supported and r.matching_operation_audit_count>0
    as state_is_consistent
from resolved r;
