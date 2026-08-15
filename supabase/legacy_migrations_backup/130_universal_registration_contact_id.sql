-- 130_universal_registration_contact_id.sql
-- Garante que todo participante (de qualquer origem: checkout publico,
-- importacao, cadastro manual) tenha um registration_contacts vinculado,
-- que passa a ser "o ID do usuario no sistema" visivel nas telas
-- administrativas. Nao mexe em create_multi_ticket_order_checkout nem em
-- nenhuma outra funcao existente -- so acrescenta um trigger + um backfill
-- de uma vez so.

begin;

create or replace function public.sync_participant_registration_contact()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cpf text := regexp_replace(coalesce(new.cpf,''),'\D','','g');
  v_contact_id uuid;
begin
  if new.registration_contact_id is not null then
    return new;
  end if;

  if length(v_cpf) <> 11
     or nullif(trim(coalesce(new.full_name,'')),'') is null
     or new.birth_date is null
     or nullif(trim(coalesce(new.phone,'')),'') is null
     or nullif(trim(coalesce(new.email,'')),'') is null
  then
    return new;
  end if;

  insert into public.registration_contacts(organization_id,full_name,cpf,birth_date,gender,phone,email,city)
  values(new.organization_id, trim(new.full_name), v_cpf, new.birth_date,
    nullif(trim(coalesce(new.gender,'')),''), regexp_replace(coalesce(new.phone,''),'\D','','g'),
    lower(trim(new.email)), nullif(trim(coalesce(new.city,'')),''))
  on conflict(organization_id,cpf) do update set updated_at=excluded.updated_at
  returning id into v_contact_id;

  new.registration_contact_id := v_contact_id;
  return new;
end;
$$;

drop trigger if exists trg_sync_participant_registration_contact on public.participants;
create trigger trg_sync_participant_registration_contact
before insert on public.participants
for each row execute function public.sync_participant_registration_contact();

-- Backfill de participantes existentes sem contato vinculado, dedupe por
-- (organization_id, cpf) -- mesma chave do indice unico ja existente
-- (ux_registration_contacts_org_cpf, migration 090).
insert into public.registration_contacts(organization_id,full_name,cpf,birth_date,gender,phone,email,city)
select distinct on (p.organization_id, regexp_replace(coalesce(p.cpf,''),'\D','','g'))
  p.organization_id, trim(p.full_name), regexp_replace(coalesce(p.cpf,''),'\D','','g'), p.birth_date,
  nullif(trim(coalesce(p.gender,'')),''), regexp_replace(coalesce(p.phone,''),'\D','','g'),
  lower(trim(p.email)), nullif(trim(coalesce(p.city,'')),'')
from public.participants p
where p.registration_contact_id is null
  and length(regexp_replace(coalesce(p.cpf,''),'\D','','g')) = 11
  and nullif(trim(coalesce(p.full_name,'')),'') is not null
  and p.birth_date is not null
  and nullif(trim(coalesce(p.phone,'')),'') is not null
  and nullif(trim(coalesce(p.email,'')),'') is not null
order by p.organization_id, regexp_replace(coalesce(p.cpf,''),'\D','','g'), p.created_at asc
on conflict (organization_id, cpf) do nothing;

update public.participants p
set registration_contact_id = rc.id
from public.registration_contacts rc
where p.registration_contact_id is null
  and rc.organization_id = p.organization_id
  and rc.cpf = regexp_replace(coalesce(p.cpf,''),'\D','','g');

commit;
