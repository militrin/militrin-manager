-- 122_batch_category_limits_preflight.sql
-- Preflight da 122: confirma que registration_batch_prices ainda nao tem
-- max_confirmed_registrations e que as funcoes a serem dropadas/recriadas
-- tem exatamente as assinaturas esperadas das migrations 011/014/015/016/121.

select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'registration_batch_prices' and column_name = 'max_confirmed_registrations';
-- esperado: nenhuma linha (coluna sera criada por esta migration)

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'get_registration_batches', 'get_event_ticket_categories', 'advance_registration_batch_if_needed',
    'upsert_registration_batch_prices', 'create_registration_batch_with_prices', 'update_registration_batch_with_prices',
    'get_registration_pricing_preview', 'create_registration', 'confirm_registration_payment'
  );
-- esperado: create_registration_batch_with_prices(uuid,text,integer,timestamptz,timestamptz,boolean,jsonb)
--           update_registration_batch_with_prices(uuid,uuid,text,integer,timestamptz,timestamptz,boolean,jsonb)
--           get_registration_batches(uuid) -- retorno atual sem ticket_category_id
--           get_event_ticket_categories(uuid) -- retorno atual sem current_batch_*
--           create_registration com os 16 parametros da 056/121

-- Quantas linhas de registration_batch_prices existem hoje (para saber o
-- volume do backfill):
select count(*) as existing_batch_prices from public.registration_batch_prices;
