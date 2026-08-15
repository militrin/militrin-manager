-- 134_registration_contact_public_pin_preflight.sql
-- Somente leitura. Confirma que registration_contacts ainda nao tem
-- public_pin e que a extensao pgcrypto (gen_random_bytes) esta disponivel
-- no schema "extensions", igual ao usado por generate_customer_public_pin
-- (migration 093).

select column_name from information_schema.columns
where table_schema='public' and table_name='registration_contacts' and column_name='public_pin';
-- esperado: nenhuma linha (coluna ainda nao existe)

select count(*) as registration_contacts_total from public.registration_contacts;
-- tamanho do backfill que a migration vai rodar

select extname, extnamespace::regnamespace as schema from pg_extension where extname='pgcrypto';
-- esperado: 1 linha, schema = extensions
