-- Materializa somente saldos legados cuja correspondencia com a variante
-- canonica e inequivoca. A entrega ticket-first usa exclusivamente
-- event_kit_item_variant_inventory por (kit_item_id, variant_id); nunca le
-- shirt_inventory nem store_item_inventory em tempo de operacao.

with candidate_matches as (
  select
    legacy.id as legacy_inventory_id,
    event.organization_id,
    legacy.event_id,
    kit_item.id as kit_item_id,
    variant.id as variant_id,
    legacy.total_quantity,
    legacy.reserved_quantity,
    legacy.delivered_quantity,
    count(*) over (partition by legacy.id) as match_count
  from public.shirt_inventory legacy
  join public.events event on event.id = legacy.event_id
  join public.event_kit_items kit_item
    on kit_item.event_id = legacy.event_id
   and kit_item.item_type = 'shirt'
   and kit_item.is_active
  join public.event_kit_item_variants variant
    on variant.kit_item_id = kit_item.id
   and variant.is_active
   and lower(trim(variant.name)) = lower(trim(legacy.shirt_type))
   and upper(trim(variant.value)) = upper(trim(legacy.shirt_size))
), unambiguous_matches as (
  select * from candidate_matches where match_count = 1
)
insert into public.event_kit_item_variant_inventory (
  organization_id,
  event_id,
  kit_item_id,
  variant_id,
  total_quantity,
  reserved_quantity,
  delivered_quantity
)
select
  organization_id,
  event_id,
  kit_item_id,
  variant_id,
  greatest(coalesce(total_quantity, 0), 0),
  greatest(coalesce(reserved_quantity, 0), 0),
  greatest(coalesce(delivered_quantity, 0), 0)
from unambiguous_matches
on conflict (kit_item_id, variant_id) do nothing;

-- Nao atualizar linhas canonicas existentes: depois de materializada, a fonte
-- canonica pode ter sido movimentada por kit principal ou produto adicional
-- vinculado. Reexecutar esta migration nunca sobrescreve esses movimentos.
