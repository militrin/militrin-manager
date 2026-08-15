-- 126_events_banner_and_autoslug_preflight.sql
-- Somente leitura. Confirma assinaturas atuais de create_event/update_event
-- (a 126 vai dropar e recriar as duas com 2 parametros novos cada) e se o
-- bucket "event-banners" ja existe no storage (precisa ser criado fora de
-- migration, via supabase.storage.createBucket, igual ao "store-item-images").

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('create_event', 'update_event');
-- esperado:
-- create_event(text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean, uuid, integer)
-- update_event(uuid, text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean)

select id, name from storage.buckets where id = 'event-banners';
-- esperado: nenhuma linha ainda -- criar o bucket publico "event-banners"
-- pelo dashboard/API do Supabase ANTES de aplicar a 126 (as policies dela
-- pressupoem que o bucket existe, mas nao falham se ainda nao existir).

select count(*) as events_with_banner_columns
from information_schema.columns
where table_schema = 'public' and table_name = 'events' and column_name in ('banner_hero_url', 'banner_card_url');
-- esperado: 0 (colunas ainda nao existem)
