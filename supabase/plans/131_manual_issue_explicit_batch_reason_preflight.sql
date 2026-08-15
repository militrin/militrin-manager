-- 131_manual_issue_explicit_batch_reason_preflight.sql
-- Somente leitura. Confirma as assinaturas atuais das duas RPCs de emissao
-- manual antes de trocar o parametro de lote automatico por um lote
-- explicito escolhido pelo admin.

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_manual_registration_order','create_manual_unassigned_ticket_order');
-- esperado: create_manual_registration_order(uuid,uuid,text,text,date,text,text,text,text,text,text,text,text,text)
--           create_manual_unassigned_ticket_order(uuid,uuid,text,text,text,text,text,text)

select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'registration_batch_prices'
order by ordinal_position;
-- esperado: confirmar que existem male_price e female_price (nao ha coluna
-- base_amount) -- a nova RPC le esses dois campos direto, sem passar por
-- get_registration_pricing_preview.
