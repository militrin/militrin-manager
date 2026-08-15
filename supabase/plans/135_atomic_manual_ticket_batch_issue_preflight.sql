-- Somente leitura. Confirma as dependencias da emissao manual atomica.
select p.proname, pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('create_manual_registration_order','create_manual_unassigned_ticket_order');

select column_name from information_schema.columns
where table_schema='public' and table_name in ('participants','order_items')
  and column_name='registration_contact_id';
