-- 119_store_order_pix_payment_preflight.sql
-- Preflight da 119: confirma que store_orders existe (116/117/118 aplicadas)
-- e que as colunas de PIX ainda nao existem.

select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'store_orders'
  and column_name in ('pix_code', 'pix_qrcode', 'gateway_payment_id', 'expires_at', 'paid_at');
-- esperado: 0 linhas

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('start_store_order_payment_pix', 'simulate_store_order_payment');
-- esperado: 0 linhas (funcoes ainda nao existem)
