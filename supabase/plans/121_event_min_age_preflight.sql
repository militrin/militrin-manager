-- 121_event_min_age_preflight.sql
-- Preflight da 121: confirma que events.min_age ainda nao existe e que as
-- funcoes a serem dropadas/recriadas tem exatamente as assinaturas esperadas
-- da 109/069/056.

select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'events' and column_name = 'min_age';
-- esperado: nenhuma linha (coluna sera criada por esta migration)

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_event', 'update_event', 'get_events_overview', 'create_registration', 'set_event_min_age', 'duplicate_event_configuration');
-- esperado: set_event_min_age ausente (sera criada); demais com as assinaturas
-- atuais (create_event sem p_min_age, get_events_overview sem min_age no
-- retorno, create_registration com os 16 parametros da 056).
