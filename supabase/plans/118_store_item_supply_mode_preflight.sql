-- 118_store_item_supply_mode_preflight.sql
-- Preflight da 118: confirma que store_items.image_url ja existe (117 aplicada)
-- e que as funcoes a serem dropadas/recriadas tem exatamente as assinaturas
-- esperadas.

select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'store_items' and column_name in ('image_url', 'supply_mode');
-- esperado: image_url presente, supply_mode ausente (sera criada por esta migration)

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('list_store_items_for_event', 'upsert_store_item', 'create_store_order', 'deliver_store_order_item', 'undo_store_order_item_delivery');
