-- 127_event_attractions_preflight.sql
-- Somente leitura. Confirma que a tabela/funcoes ainda nao existem (a 127 e
-- aditiva, sem drop de nada existente) e que a permissao events.edit e o
-- bucket event-banners (criado antes da 126) ja existem.

select to_regclass('public.event_attractions') as table_already_exists;
-- esperado: null

select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('upsert_event_attraction', 'delete_event_attraction');
-- esperado: nenhuma linha

select code from public.admin_permissions where code = 'events.edit';
-- esperado: 1 linha (events.edit) -- usada pelas novas RPCs

select id from storage.buckets where id = 'event-banners';
-- esperado: 1 linha -- o upload de banner de atracao reaproveita este bucket
