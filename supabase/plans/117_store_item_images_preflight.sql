-- 117_store_item_images_preflight.sql
-- Preflight da 117: confirma que store_items existe (criada pela 116), que o
-- bucket "store-item-images" ja foi criado (via API, fora de SQL) e que as
-- funcoes atuais tem exatamente as assinaturas que serao dropadas/recriadas.

select to_regclass('public.store_items') as store_items;

select id, name, public from storage.buckets where id = 'store-item-images';
-- esperado: 1 linha, public = true

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('upsert_store_item', 'list_store_items_for_event');
