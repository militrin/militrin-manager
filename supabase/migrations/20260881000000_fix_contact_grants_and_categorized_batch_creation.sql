-- Homologacao: vincula concessoes contact-first a conta canonica e corrige
-- a transicao de lotes de ingresso unico para precos por categoria.
begin;

create or replace function public.sync_store_order_registration_contact()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
declare v_contact_user_id uuid;
begin
  if new.registration_contact_id is null and new.participant_id is not null then
    select p.registration_contact_id into new.registration_contact_id
    from public.participants p
    where p.id = new.participant_id
      and p.organization_id = new.organization_id
      and p.event_id = new.event_id;
  end if;

  if new.registration_contact_id is not null then
    select rc.user_id into v_contact_user_id
    from public.registration_contacts rc
    where rc.id = new.registration_contact_id
      and rc.organization_id = new.organization_id;
    new.user_id := coalesce(new.user_id, v_contact_user_id);
  end if;
  return new;
end; $$;

drop trigger if exists trg_sync_store_order_registration_contact on public.store_orders;
create trigger trg_sync_store_order_registration_contact
before insert or update of participant_id, registration_contact_id, user_id on public.store_orders
for each row execute function public.sync_store_order_registration_contact();

-- Backfill somente quando o contato ja possui uma conta canonica inequívoca.
update public.store_orders so
set user_id = rc.user_id,
    updated_at = now()
from public.registration_contacts rc
where so.user_id is null
  and so.registration_contact_id = rc.id
  and so.organization_id = rc.organization_id
  and rc.user_id is not null;

create or replace function public.create_registration_batch_with_prices(
  p_event_id uuid,
  p_name text default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_is_active boolean default false,
  p_prices jsonb default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_batch_id uuid;
  v_sequence_number integer;
  v_name text;
  v_item jsonb;
  v_enabled_prices jsonb := '[]'::jsonb;
  v_ticket_category_id uuid;
  v_enabled boolean;
  v_male_price numeric;
  v_female_price numeric;
  v_max_confirmed integer;
  v_enabled_count integer := 0;
  v_sum_max_confirmed integer := 0;
  v_legacy_male_price numeric;
  v_legacy_female_price numeric;
begin
  if p_event_id is null then raise exception 'Evento obrigatorio.'; end if;
  perform 1 from public.events where id = p_event_id for update;
  if not found then raise exception 'Evento nao encontrado.'; end if;
  if p_starts_at is not null and p_ends_at is not null and p_ends_at < p_starts_at then
    raise exception 'Data final nao pode ser anterior a data inicial.';
  end if;
  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then
    raise exception 'Lista de precos por categoria invalida.';
  end if;

  for v_item in select value from jsonb_array_elements(p_prices)
  loop
    v_enabled := coalesce((v_item->>'enabled')::boolean, false);
    if not v_enabled then continue; end if;

    begin
      v_ticket_category_id := (v_item->>'ticket_category_id')::uuid;
    exception when others then
      raise exception 'Categoria invalida na lista de precos.';
    end;

    if not exists (
      select 1 from public.ticket_categories tc
      where tc.id = v_ticket_category_id and tc.event_id = p_event_id and tc.is_active
    ) then
      raise exception 'A categoria selecionada nao esta ativa neste evento.';
    end if;

    v_male_price := nullif(v_item->>'male_price', '')::numeric;
    v_female_price := nullif(v_item->>'female_price', '')::numeric;
    v_max_confirmed := nullif(v_item->>'max_confirmed_registrations', '')::integer;
    if v_male_price is null or v_female_price is null or v_male_price < 0 or v_female_price < 0 then
      raise exception 'Informe precos masculino e feminino validos para cada categoria ativa.';
    end if;
    if v_max_confirmed is not null and v_max_confirmed <= 0 then
      raise exception 'O limite de confirmados deve ser maior que zero.';
    end if;
    if v_max_confirmed is null and p_ends_at is null then
      raise exception 'Informe um limite de confirmados, uma data de encerramento, ou os dois.';
    end if;

    v_enabled_count := v_enabled_count + 1;
    v_sum_max_confirmed := v_sum_max_confirmed + coalesce(v_max_confirmed, 0);
    v_enabled_prices := v_enabled_prices || jsonb_build_array(v_item || jsonb_build_object('enabled', true));
    if v_enabled_count = 1 then
      v_legacy_male_price := round(v_male_price, 2);
      v_legacy_female_price := round(v_female_price, 2);
    end if;
  end loop;

  if v_enabled_count = 0 then raise exception 'Ative pelo menos uma categoria no lote.'; end if;
  perform 1 from public.registration_batches where event_id = p_event_id for update;
  select coalesce(max(sequence_number), 0) + 1 into v_sequence_number
  from public.registration_batches where event_id = p_event_id;
  v_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), format('%sº Lote', v_sequence_number));

  if coalesce(p_is_active, false) then
    update public.registration_batches
    set is_active = false, updated_at = now()
    where event_id = p_event_id and not flat_price_confirmed;
  end if;

  insert into public.registration_batches (
    event_id, name, sequence_number, male_price, female_price,
    max_confirmed_registrations, starts_at, ends_at, is_active, flat_price_confirmed
  ) values (
    p_event_id, v_name, v_sequence_number, v_legacy_male_price, v_legacy_female_price,
    v_sum_max_confirmed, p_starts_at, p_ends_at, coalesce(p_is_active, false), false
  ) returning id into v_batch_id;

  perform public.upsert_registration_batch_prices(v_batch_id, p_event_id, v_enabled_prices);
  insert into public.audit_logs(action, entity_type, entity_id, details, event_id)
  values ('registration_batch_created', 'registration_batches', v_batch_id,
    jsonb_build_object('name', v_name, 'sequence_number', v_sequence_number,
      'is_active', coalesce(p_is_active, false), 'enabled_categories', v_enabled_count,
      'preserved_single_ticket_batches', true), p_event_id);
  return v_batch_id;
exception when unique_violation then
  raise exception 'Outro lote foi criado ao mesmo tempo. Atualize a pagina e tente novamente.';
end; $$;

create or replace function public.activate_registration_batch(p_batch_id uuid, p_event_id uuid)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_batch public.registration_batches%rowtype;
begin
  select * into v_batch from public.registration_batches
  where id = p_batch_id and event_id = p_event_id for update;
  if not found then raise exception 'Lote nao encontrado para o evento.'; end if;

  if not v_batch.flat_price_confirmed then
    update public.registration_batches set is_active = false, updated_at = now()
    where event_id = p_event_id and id <> p_batch_id and not flat_price_confirmed;
  end if;
  update public.registration_batches set is_active = true, updated_at = now() where id = p_batch_id;
  insert into public.audit_logs(action, entity_type, entity_id, details, event_id)
  values ('registration_batch_activated', 'registration_batches', p_batch_id,
    jsonb_build_object('sequence_number', v_batch.sequence_number), p_event_id);
  return true;
end; $$;

revoke all on function public.create_registration_batch_with_prices(uuid,text,timestamptz,timestamptz,boolean,jsonb) from public;
grant execute on function public.create_registration_batch_with_prices(uuid,text,timestamptz,timestamptz,boolean,jsonb) to authenticated, service_role;
revoke all on function public.activate_registration_batch(uuid,uuid) from public;
grant execute on function public.activate_registration_batch(uuid,uuid) to authenticated, service_role;

commit;
