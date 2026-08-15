-- 130_universal_registration_contact_id_preflight.sql
-- Somente leitura. Mede o tamanho do backfill antes de aplicar a migration
-- (trigger + preenchimento de participants.registration_contact_id).

select count(*) as participants_total,
  count(*) filter (where registration_contact_id is null) as sem_contato,
  count(*) filter (
    where registration_contact_id is null
      and length(regexp_replace(coalesce(cpf,''),'\D','','g')) = 11
      and nullif(trim(coalesce(full_name,'')),'') is not null
      and birth_date is not null
      and nullif(trim(coalesce(phone,'')),'') is not null
      and nullif(trim(coalesce(email,'')),'') is not null
  ) as sera_vinculado_no_backfill
from public.participants;
-- "sera_vinculado_no_backfill" deve ficar proximo de "sem_contato"; a
-- diferenca sao linhas com dado cadastral incompleto (cpf/email/telefone/
-- nascimento ausentes), que ficam sem ID ate o cadastro ser corrigido.

select count(*) as registration_contacts_hoje from public.registration_contacts;
