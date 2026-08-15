-- 114_optional_loyalty_preflight.sql
-- Preflight da 114: confirma que apenas checkin_participant_entry (ja com guard)
-- e checkin_ticket_entry (sem guard) referenciam recalculate_customer_loyalty,
-- e que o corpo ao vivo de checkin_ticket_entry e o da 087.
--
-- Executado em 2026-08-11 no banco de producao. Resultado:
--   checkin_participant_entry | 2e952e076ed8baf0398db7df511b196e | guarded=true
--   checkin_ticket_entry      | 3772914a634a6bf7b109038aac9e0cc1 | guarded=false
-- O md5 3772914a... corresponde byte a byte ao corpo definido na 087
-- com finais de linha CRLF (46b07df1... na variante LF do arquivo).

select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       md5(p.prosrc) as body_md5,
       position('to_regprocedure' in p.prosrc) > 0 as guarded
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosrc like '%recalculate_customer_loyalty%'
order by 1;
