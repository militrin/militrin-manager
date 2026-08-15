-- 016_batches_auto_sequence_and_ux.sql
-- Ajusta RPCs de lotes para sequencia/nome automaticos e validação por categoria.

drop function if exists public.create_registration_batch_with_prices(
  uuid,
  text,
  integer,
  numeric,
  numeric,
  integer,
  timestamptz,
  timestamptz,
  boolean,
  jsonb
);

drop function if exists public.update_registration_batch_with_prices(
  uuid,
  uuid,
  text,
  integer,
  numeric,
  numeric,
  integer,
  timestamptz,
  timestamptz,
  boolean,
  jsonb
);

create or replace function public.create_registration_batch_with_prices(
  p_event_id uuid,
  p_name text default null,
  p_max_confirmed_registrations integer default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_is_active boolean default false,
  p_prices jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_sequence_number integer;
  v_name text;
  v_item jsonb;
  v_ticket_category_id uuid;
  v_enabled boolean;
  v_male_price numeric;
  v_female_price numeric;
  v_enabled_count integer := 0;
  v_legacy_male_price numeric := null;
  v_legacy_female_price numeric := null;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  perform 1
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if p_max_confirmed_registrations is null or p_max_confirmed_registrations <= 0 then
    raise exception 'Limite do lote deve ser maior que zero.';
  end if;

  if p_starts_at is not null and p_ends_at is not null and p_ends_at < p_starts_at then
    raise exception 'Data final nao pode ser anterior a data inicial.';
  end if;

  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then
    raise exception 'Lista de precos por categoria invalida.';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_prices)
  loop
    begin
      v_ticket_category_id := (v_item->>'ticket_category_id')::uuid;
    exception
      when others then
        raise exception 'Categoria invalida na lista de precos.';
    end;

    v_enabled := coalesce((v_item->>'enabled')::boolean, false);
    v_male_price := nullif(v_item->>'male_price', '')::numeric;
    v_female_price := nullif(v_item->>'female_price', '')::numeric;

    if not exists (
      select 1
      from public.ticket_categories tc
      where tc.id = v_ticket_category_id
        and tc.event_id = p_event_id
        and tc.is_active = true
    ) then
      raise exception 'Categoria % nao pertence ao evento ativo.', v_ticket_category_id;
    end if;

    if not v_enabled then
      continue;
    end if;

    if v_male_price is null or v_female_price is null then
      raise exception 'Toda categoria ativa deve possuir preco masculino e feminino.';
    end if;

    if v_male_price < 0 or v_female_price < 0 then
      raise exception 'Precos devem ser maiores ou iguais a zero.';
    end if;

    v_enabled_count := v_enabled_count + 1;

    if v_enabled_count = 1 then
      v_legacy_male_price := round(v_male_price, 2);
      v_legacy_female_price := round(v_female_price, 2);
    end if;
  end loop;

  if v_enabled_count = 0 then
    raise exception 'Ative pelo menos uma categoria no lote.';
  end if;

  perform 1
  from public.registration_batches
  where event_id = p_event_id
  for update;

  select coalesce(max(sequence_number), 0) + 1
    into v_sequence_number
  from public.registration_batches
  where event_id = p_event_id;

  v_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), format('%sº Lote', v_sequence_number));

  if coalesce(p_is_active, false) then
    update public.registration_batches
    set is_active = false,
        updated_at = now()
    where event_id = p_event_id;
  end if;

  insert into public.registration_batches (
    event_id,
    name,
    sequence_number,
    male_price,
    female_price,
    max_confirmed_registrations,
    starts_at,
    ends_at,
    is_active
  ) values (
    p_event_id,
    v_name,
    v_sequence_number,
    v_legacy_male_price,
    v_legacy_female_price,
    p_max_confirmed_registrations,
    p_starts_at,
    p_ends_at,
    coalesce(p_is_active, false)
  ) returning id into v_batch_id;

  perform public.upsert_registration_batch_prices(
    v_batch_id,
    p_event_id,
    p_prices
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_created',
    'registration_batches',
    v_batch_id,
    jsonb_build_object(
      'name', v_name,
      'sequence_number', v_sequence_number,
      'male_price', v_legacy_male_price,
      'female_price', v_legacy_female_price,
      'max_confirmed_registrations', p_max_confirmed_registrations,
      'is_active', coalesce(p_is_active, false),
      'enabled_categories', v_enabled_count,
      'auto_sequence', true
    ),
    p_event_id
  );

  return v_batch_id;
exception
  when unique_violation then
    raise exception 'Conflito de concorrencia ao gerar sequencia do lote. Tente novamente.';
end;
$$;

create or replace function public.update_registration_batch_with_prices(
  p_batch_id uuid,
  p_event_id uuid,
  p_name text default null,
  p_max_confirmed_registrations integer default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_is_active boolean default false,
  p_prices jsonb default '[]'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch public.registration_batches%rowtype;
  v_confirmed_count integer;
  v_name text;
  v_item jsonb;
  v_ticket_category_id uuid;
  v_enabled boolean;
  v_male_price numeric;
  v_female_price numeric;
  v_enabled_count integer := 0;
  v_legacy_male_price numeric := null;
  v_legacy_female_price numeric := null;
begin
  if p_batch_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select * into v_batch
  from public.registration_batches
  where id = p_batch_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Lote nao encontrado para o evento.';
  end if;

  if p_max_confirmed_registrations is null or p_max_confirmed_registrations <= 0 then
    raise exception 'Limite do lote deve ser maior que zero.';
  end if;

  if p_starts_at is not null and p_ends_at is not null and p_ends_at < p_starts_at then
    raise exception 'Data final nao pode ser anterior a data inicial.';
  end if;

  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then
    raise exception 'Lista de precos por categoria invalida.';
  end if;

  for v_item in
    select value
    from jsonb_array_elements(p_prices)
  loop
    begin
      v_ticket_category_id := (v_item->>'ticket_category_id')::uuid;
    exception
      when others then
        raise exception 'Categoria invalida na lista de precos.';
    end;

    v_enabled := coalesce((v_item->>'enabled')::boolean, false);
    v_male_price := nullif(v_item->>'male_price', '')::numeric;
    v_female_price := nullif(v_item->>'female_price', '')::numeric;

    if not exists (
      select 1
      from public.ticket_categories tc
      where tc.id = v_ticket_category_id
        and tc.event_id = p_event_id
        and tc.is_active = true
    ) then
      raise exception 'Categoria % nao pertence ao evento ativo.', v_ticket_category_id;
    end if;

    if not v_enabled then
      continue;
    end if;

    if v_male_price is null or v_female_price is null then
      raise exception 'Toda categoria ativa deve possuir preco masculino e feminino.';
    end if;

    if v_male_price < 0 or v_female_price < 0 then
      raise exception 'Precos devem ser maiores ou iguais a zero.';
    end if;

    v_enabled_count := v_enabled_count + 1;

    if v_enabled_count = 1 then
      v_legacy_male_price := round(v_male_price, 2);
      v_legacy_female_price := round(v_female_price, 2);
    end if;
  end loop;

  if v_enabled_count = 0 then
    raise exception 'Ative pelo menos uma categoria no lote.';
  end if;

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = p_batch_id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  if p_max_confirmed_registrations < v_confirmed_count then
    raise exception 'Nao e permitido reduzir limite abaixo das inscricoes confirmadas (%).', v_confirmed_count;
  end if;

  v_name := coalesce(nullif(trim(coalesce(p_name, '')), ''), format('%sº Lote', v_batch.sequence_number));

  if coalesce(p_is_active, false) then
    update public.registration_batches
    set is_active = false,
        updated_at = now()
    where event_id = p_event_id
      and id <> p_batch_id;
  end if;

  update public.registration_batches
  set
    name = v_name,
    male_price = v_legacy_male_price,
    female_price = v_legacy_female_price,
    max_confirmed_registrations = p_max_confirmed_registrations,
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    is_active = coalesce(p_is_active, false),
    updated_at = now()
  where id = p_batch_id
    and event_id = p_event_id;

  perform public.upsert_registration_batch_prices(
    p_batch_id,
    p_event_id,
    p_prices
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_updated',
    'registration_batches',
    p_batch_id,
    jsonb_build_object(
      'name', v_name,
      'sequence_number', v_batch.sequence_number,
      'male_price', v_legacy_male_price,
      'female_price', v_legacy_female_price,
      'max_confirmed_registrations', p_max_confirmed_registrations,
      'is_active', coalesce(p_is_active, false),
      'enabled_categories', v_enabled_count,
      'sequence_locked', true
    ),
    p_event_id
  );

  return true;
end;
$$;

revoke all on function public.create_registration_batch_with_prices(uuid, text, integer, timestamptz, timestamptz, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.update_registration_batch_with_prices(uuid, uuid, text, integer, timestamptz, timestamptz, boolean, jsonb) from public, anon, authenticated;

grant execute on function public.create_registration_batch_with_prices(uuid, text, integer, timestamptz, timestamptz, boolean, jsonb) to anon, authenticated;
grant execute on function public.update_registration_batch_with_prices(uuid, uuid, text, integer, timestamptz, timestamptz, boolean, jsonb) to anon, authenticated;
