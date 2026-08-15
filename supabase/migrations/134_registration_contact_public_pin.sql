-- 134_registration_contact_public_pin.sql
-- Da a registration_contacts um PIN publico curto, no mesmo padrao ja usado
-- por customer_profiles.public_pin (migration 093): 10 caracteres
-- alfanumericos, gerados aleatoriamente, unicos em todo o sistema. Esse PIN
-- passa a ser o identificador visivel do cadastro em toda a UI
-- administrativa (Cadastros, Operacoes, Ficha completa, Emitir ingresso) --
-- o UUID (registration_contacts.id) continua existindo e sendo usado
-- internamente pelo codigo/RPCs, mas nunca mais e mostrado nem digitado
-- pelo admin.

begin;

alter table public.registration_contacts add column if not exists public_pin text;

create unique index if not exists ux_registration_contacts_public_pin on public.registration_contacts(public_pin) where public_pin is not null;
alter table public.registration_contacts drop constraint if exists registration_contacts_public_pin_format;
alter table public.registration_contacts add constraint registration_contacts_public_pin_format check(public_pin is null or public_pin ~ '^[A-Z0-9]{10}$');

create or replace function public.generate_registration_contact_public_pin() returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pin text;
begin
  perform pg_advisory_xact_lock(hashtext('public.registration_contacts.public_pin'));
  loop
    v_pin:=upper(encode(extensions.gen_random_bytes(5),'hex'));
    exit when not exists(select 1 from public.registration_contacts where public_pin=v_pin);
  end loop;
  return v_pin;
end; $$;

do $$
declare v_contact record; v_assigned boolean;
begin
  for v_contact in select id from public.registration_contacts where public_pin is null order by id loop
    v_assigned:=false;
    while not v_assigned loop
      begin
        update public.registration_contacts set public_pin=public.generate_registration_contact_public_pin() where id=v_contact.id and public_pin is null;
        v_assigned:=true;
      exception when unique_violation then
        v_assigned:=false;
      end;
    end loop;
  end loop;
end; $$;
alter table public.registration_contacts alter column public_pin set default public.generate_registration_contact_public_pin();
alter table public.registration_contacts alter column public_pin set not null;

revoke all on function public.generate_registration_contact_public_pin() from public,anon,authenticated;

commit;
