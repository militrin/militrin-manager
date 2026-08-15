-- 104_event_shirt_supply_mode_diagnostic.sql
-- Estritamente somente leitura: nenhuma classificacao e inferida do estoque.

select
  e.organization_id,
  e.id as event_id,
  e.name as event_name,
  eki.id as kit_item_id,
  eki.name as kit_item_name,
  nullif(to_jsonb(eki)->>'shirt_supply_mode','') as current_supply_mode,
  eki.allow_participant_change,
  count(distinct v.id) filter(where v.is_active) as enabled_variant_count,
  count(distinct inv.variant_id) filter(
    where inv.total_quantity-inv.reserved_quantity-inv.delivered_quantity>0
  ) as variants_with_available_stock,
  coalesce(sum(inv.total_quantity-inv.reserved_quantity-inv.delivered_quantity),0) as available_stock,
  case
    when nullif(to_jsonb(eki)->>'shirt_supply_mode','') is null then 'unclassified'
    when to_jsonb(eki)->>'shirt_supply_mode' not in('stock','made_to_order','disabled') then 'invalid'
    else 'classified'
  end as classification_state
from public.events e
join public.event_kit_items eki on eki.event_id=e.id
left join public.event_kit_item_variants v on v.kit_item_id=eki.id
left join public.event_kit_item_variant_inventory inv
  on inv.kit_item_id=eki.id and inv.variant_id=v.id
where eki.item_type='shirt' and eki.is_active
group by e.organization_id,e.id,e.name,eki.id,eki.name,eki.allow_participant_change
order by e.name,eki.sort_order,eki.id;
