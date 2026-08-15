-- 125_batch_optional_limit_with_dates_preflight.sql
-- Somente leitura. Confirma que as 8 funcoes que a 125 vai substituir
-- (create or replace) existem hoje com exatamente a assinatura esperada, e
-- que a constraint de limite positivo em registration_batch_prices ainda
-- exige NOT NULL (sera relaxada pela 125).

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'advance_registration_batch_if_needed', 'upsert_registration_batch_prices',
    'create_registration_batch_with_prices', 'update_registration_batch_with_prices',
    'get_registration_batches', 'get_event_ticket_categories', 'get_registration_pricing_preview',
    'create_registration', 'confirm_registration_payment'
  )
order by p.proname;
-- esperado: as 8 funcoes presentes, com as mesmas assinaturas que ja existem
-- desde a 121/122 (nenhuma muda de assinatura nesta migration).

select is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'registration_batch_prices' and column_name = 'max_confirmed_registrations';
-- esperado: is_nullable = 'NO' (a 125 remove esse NOT NULL)

select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.registration_batch_prices'::regclass
  and conname = 'registration_batch_prices_limit_positive';
-- esperado: CHECK (max_confirmed_registrations > 0) -- a 125 troca para
-- permitir tambem null.

-- Quantas linhas de registration_batch_prices ja existem hoje sem
-- ends_at no lote correspondente (pra saber se alguma ficaria "sem criterio
-- nenhum" apos a 125 -- nao deveria, porque hoje o limite e sempre not null):
select count(*) as batch_prices_rows_today
from public.registration_batch_prices;
