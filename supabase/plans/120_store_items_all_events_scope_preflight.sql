-- 120_store_items_all_events_scope_preflight.sql
-- Preflight da 120: confirma que event_id ainda e NOT NULL em store_items/
-- store_item_inventory (sera relaxado por esta migration) e que as funcoes a
-- serem dropadas/recriadas tem exatamente as assinaturas esperadas da 118/116.

select table_name, column_name, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('store_items', 'store_item_inventory')
  and column_name = 'event_id';
-- esperado: is_nullable = 'NO' nas duas linhas (sera alterado para 'YES')

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('list_store_items_for_event', 'upsert_store_item', 'create_store_order', 'trg_store_items_set_org', 'trg_store_item_inventory_set_org');
