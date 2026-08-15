-- 125_batch_optional_limit_with_dates.sql
-- Ate a 122, toda categoria ativada num lote precisava obrigatoriamente de um
-- limite de confirmados (registration_batch_prices.max_confirmed_registrations
-- not null, > 0). As datas do lote (registration_batches.starts_at/ends_at)
-- ja existiam e ja eram validadas (fim >= inicio), mas nunca eram usadas pra
-- fechar um lote sozinhas -- nenhuma funcao comparava com now().
--
-- Esta migration deixa o limite por categoria opcional: cada categoria ativa
-- num lote passa a poder ter limite de confirmados, data de encerramento do
-- lote (ends_at), ou os dois -- quem decide e quem esta configurando o lote,
-- desde que pelo menos um dos dois criterios exista (senao o lote nunca
-- fecharia sozinho por engano). Toda checagem de "categoria esgotada nesse
-- lote" (nas 5 funcoes que fazem essa checagem: advance_registration_batch_if_needed,
-- get_event_ticket_categories, get_registration_pricing_preview,
-- create_registration, confirm_registration_payment) passa a considerar
-- esgotada quando o limite existir e for atingido, OU quando o lote tiver
-- data de encerramento e ela ja tiver passado. E 100% avaliacao preguicosa
-- (lazy), no mesmo estilo que ja existia pra limite -- nao precisa de cron.
--
-- create_multi_ticket_order_checkout (024, remendada por varias migrations
-- depois) nao e tocada aqui -- ela resolve lote/preco chamando
-- get_registration_pricing_preview, entao herda a checagem nova automaticamente.
--
-- Escopo tocado (todas com corpo integral reproduzido a partir da 122, unica
-- definicao ativa de cada uma): advance_registration_batch_if_needed,
-- upsert_registration_batch_prices, create_registration_batch_with_prices,
-- update_registration_batch_with_prices, get_registration_batches,
-- get_event_ticket_categories, get_registration_pricing_preview,
-- create_registration, confirm_registration_payment.

begin;

-- ============================================================
-- 1. Limite por categoria vira opcional.
-- ============================================================

alter table public.registration_batch_prices alter column max_confirmed_registrations drop not null;

alter table public.registration_batch_prices drop constraint if exists registration_batch_prices_limit_positive;
alter table public.registration_batch_prices add constraint registration_batch_prices_limit_positive
  check (max_confirmed_registrations is null or max_confirmed_registrations > 0);

-- ============================================================
-- 2. advance_registration_batch_if_needed: esgotado por categoria (quando
--    tem limite) OU por data do lote (quando tem ends_at e ja passou).
-- ============================================================

create or replace function public.advance_registration_batch_if_needed(
  p_event_id uuid default null
)
returns table (
  switched boolean,
  previous_batch_id uuid,
  new_batch_id uuid,
  message text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid := p_event_id;
  v_current public.registration_batches%rowtype;
  v_next public.registration_batches%rowtype;
  v_fully_exhausted boolean;
begin
  if v_event_id is null then
    select id into v_event_id
    from public.events
    where is_active = true
    order by created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado para avancar lote.';
  end if;

  select * into v_current
  from public.registration_batches
  where event_id = v_event_id
    and is_active = true
  order by sequence_number asc
  limit 1
  for update;

  if not found then
    raise exception 'Nenhum lote ativo configurado para o evento.';
  end if;

  select not exists (
    select 1
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_current.id
      and (
        rbp.max_confirmed_registrations is null
        or coalesce((
          select count(*)::integer
          from public.participants part
          join public.payments pay on pay.participant_id = part.id
          where part.batch_id = v_current.id
            and part.ticket_category_id = rbp.ticket_category_id
            and coalesce(part.registration_status, 'pending') <> 'cancelled'
            and pay.payment_status = 'paid'
            and (part.reservation_status is null or part.reservation_status = 'confirmed')
        ), 0) < rbp.max_confirmed_registrations
      )
      and (v_current.ends_at is null or now() <= v_current.ends_at)
  ) into v_fully_exhausted;

  if not v_fully_exhausted then
    return query select false, v_current.id, v_current.id, 'Lote ativo ainda com vagas.';
    return;
  end if;

  select * into v_next
  from public.registration_batches
  where event_id = v_event_id
    and sequence_number > v_current.sequence_number
  order by sequence_number asc
  limit 1
  for update;

  if not found then
    return query select false, v_current.id, null::uuid, 'Lote atual esgotado e sem proximo lote.';
    return;
  end if;

  update public.registration_batches
  set is_active = false,
      updated_at = now()
  where id = v_current.id;

  update public.registration_batches
  set is_active = true,
      updated_at = now()
  where id = v_next.id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_advanced',
    'registration_batches',
    v_next.id,
    jsonb_build_object(
      'previous_batch_id', v_current.id,
      'previous_sequence', v_current.sequence_number,
      'new_batch_id', v_next.id,
      'new_sequence', v_next.sequence_number
    ),
    v_event_id
  );

  return query select true, v_current.id, v_next.id, format('Lote avancado de %s para %s.', v_current.name, v_next.name);
end;
$$;

-- ============================================================
-- 3. upsert_registration_batch_prices: limite vira opcional, mas exige pelo
--    menos um criterio (limite ou data de encerramento do lote) por
--    categoria ativada.
-- ============================================================

create or replace function public.upsert_registration_batch_prices(
  p_batch_id uuid,
  p_event_id uuid,
  p_prices jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_ticket_category_id uuid;
  v_enabled boolean;
  v_male_price numeric;
  v_female_price numeric;
  v_max_confirmed integer;
  v_existing_confirmed integer;
  v_count integer := 0;
  v_deleted integer := 0;
  v_batch_ends_at timestamptz;
begin
  if p_batch_id is null or p_event_id is null then
    raise exception 'Batch e evento sao obrigatorios.';
  end if;

  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then
    raise exception 'Lista de precos por categoria invalida.';
  end if;

  select ends_at into v_batch_ends_at
  from public.registration_batches
  where id = p_batch_id
    and event_id = p_event_id;

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
    v_male_price := coalesce((v_item->>'male_price')::numeric, 0);
    v_female_price := coalesce((v_item->>'female_price')::numeric, 0);
    v_max_confirmed := nullif(v_item->>'max_confirmed_registrations', '')::integer;

    if not exists (
      select 1
      from public.ticket_categories tc
      where tc.id = v_ticket_category_id
        and tc.event_id = p_event_id
    ) then
      raise exception 'Categoria % nao pertence ao evento.', v_ticket_category_id;
    end if;

    if not v_enabled then
      delete from public.registration_batch_prices
      where batch_id = p_batch_id
        and ticket_category_id = v_ticket_category_id;

      v_deleted := v_deleted + 1;
      continue;
    end if;

    if v_male_price < 0 or v_female_price < 0 then
      raise exception 'Preco por categoria nao pode ser negativo.';
    end if;

    if v_max_confirmed is not null and v_max_confirmed <= 0 then
      raise exception 'Limite de confirmados por categoria deve ser maior que zero quando informado.';
    end if;

    if v_max_confirmed is null and v_batch_ends_at is null then
      raise exception 'Categoria ativa no lote precisa de um limite de confirmados, de uma data de encerramento do lote, ou dos dois.';
    end if;

    if v_max_confirmed is not null then
      select coalesce(count(*)::integer, 0) into v_existing_confirmed
      from public.participants part
      join public.payments pay on pay.participant_id = part.id
      where part.batch_id = p_batch_id
        and part.ticket_category_id = v_ticket_category_id
        and coalesce(part.registration_status, 'pending') <> 'cancelled'
        and pay.payment_status = 'paid'
        and (part.reservation_status is null or part.reservation_status = 'confirmed');

      if v_max_confirmed < v_existing_confirmed then
        raise exception 'Nao e permitido reduzir o limite da categoria abaixo das inscricoes ja confirmadas (%).', v_existing_confirmed;
      end if;
    end if;

    insert into public.registration_batch_prices (
      batch_id,
      ticket_category_id,
      male_price,
      female_price,
      max_confirmed_registrations
    )
    values (
      p_batch_id,
      v_ticket_category_id,
      round(v_male_price, 2),
      round(v_female_price, 2),
      v_max_confirmed
    )
    on conflict (batch_id, ticket_category_id)
    do update set
      male_price = excluded.male_price,
      female_price = excluded.female_price,
      max_confirmed_registrations = excluded.max_confirmed_registrations,
      updated_at = now();

    v_count := v_count + 1;
  end loop;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_prices_upserted',
    'registration_batches',
    p_batch_id,
    jsonb_build_object(
      'updated_prices', v_count,
      'disabled_prices', v_deleted
    ),
    p_event_id
  );

  return true;
end;
$$;

-- ============================================================
-- 4. create_registration_batch_with_prices / update_registration_batch_with_prices:
--    mesma flexibilizacao (limite ou p_ends_at, ou os dois) na validacao por
--    categoria ativada. A soma agregada (legado, sem uso em checagem) trata
--    limite nulo como zero pra nao virar null.
-- ============================================================

create or replace function public.create_registration_batch_with_prices(
  p_event_id uuid,
  p_name text default null,
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
  v_max_confirmed integer;
  v_enabled_count integer := 0;
  v_sum_max_confirmed integer := 0;
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
    v_max_confirmed := nullif(v_item->>'max_confirmed_registrations', '')::integer;

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

    if v_max_confirmed is not null and v_max_confirmed <= 0 then
      raise exception 'Limite de confirmados deve ser maior que zero quando informado.';
    end if;

    if v_max_confirmed is null and p_ends_at is null then
      raise exception 'Toda categoria ativa deve possuir um limite de confirmados, uma data de encerramento do lote, ou os dois.';
    end if;

    v_enabled_count := v_enabled_count + 1;
    v_sum_max_confirmed := v_sum_max_confirmed + coalesce(v_max_confirmed, 0);

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
    v_sum_max_confirmed,
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
      'max_confirmed_registrations_sum', v_sum_max_confirmed,
      'is_active', coalesce(p_is_active, false),
      'enabled_categories', v_enabled_count,
      'auto_sequence', true,
      'per_category_limits', true,
      'optional_limit_with_dates', true
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
  v_name text;
  v_item jsonb;
  v_ticket_category_id uuid;
  v_enabled boolean;
  v_male_price numeric;
  v_female_price numeric;
  v_max_confirmed integer;
  v_enabled_count integer := 0;
  v_sum_max_confirmed integer := 0;
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
    v_max_confirmed := nullif(v_item->>'max_confirmed_registrations', '')::integer;

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

    if v_max_confirmed is not null and v_max_confirmed <= 0 then
      raise exception 'Limite de confirmados deve ser maior que zero quando informado.';
    end if;

    if v_max_confirmed is null and p_ends_at is null then
      raise exception 'Toda categoria ativa deve possuir um limite de confirmados, uma data de encerramento do lote, ou os dois.';
    end if;

    v_enabled_count := v_enabled_count + 1;
    v_sum_max_confirmed := v_sum_max_confirmed + coalesce(v_max_confirmed, 0);

    if v_enabled_count = 1 then
      v_legacy_male_price := round(v_male_price, 2);
      v_legacy_female_price := round(v_female_price, 2);
    end if;
  end loop;

  if v_enabled_count = 0 then
    raise exception 'Ative pelo menos uma categoria no lote.';
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
    max_confirmed_registrations = v_sum_max_confirmed,
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    is_active = coalesce(p_is_active, false),
    updated_at = now()
  where id = p_batch_id
    and event_id = p_event_id;

  -- Valida reducao abaixo do confirmado (por categoria) dentro do proprio
  -- upsert_registration_batch_prices, que ja compara cada item com o
  -- confirmado daquela (lote, categoria) antes de gravar.
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
      'max_confirmed_registrations_sum', v_sum_max_confirmed,
      'is_active', coalesce(p_is_active, false),
      'enabled_categories', v_enabled_count,
      'sequence_locked', true,
      'per_category_limits', true,
      'optional_limit_with_dates', true
    ),
    p_event_id
  );

  return true;
end;
$$;

revoke all on function public.create_registration_batch_with_prices(uuid, text, timestamptz, timestamptz, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.update_registration_batch_with_prices(uuid, uuid, text, timestamptz, timestamptz, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.create_registration_batch_with_prices(uuid, text, timestamptz, timestamptz, boolean, jsonb) to anon, authenticated;
grant execute on function public.update_registration_batch_with_prices(uuid, uuid, text, timestamptz, timestamptz, boolean, jsonb) to anon, authenticated;

-- ============================================================
-- 5. get_registration_batches: remaining_slots vira null (sem teto de
--    quantidade) em vez de 0 quando o limite da categoria for null -- 0
--    passaria a falsa impressao de esgotado.
-- ============================================================

create or replace function public.get_registration_batches(
  p_event_id uuid default null
)
returns table (
  id uuid,
  event_id uuid,
  name text,
  sequence_number integer,
  ticket_category_id uuid,
  category_name text,
  male_price numeric,
  female_price numeric,
  max_confirmed_registrations integer,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean,
  confirmed_count integer,
  remaining_slots integer,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid := p_event_id;
begin
  if v_event_id is null then
    select e.id into v_event_id
    from public.events e
    where e.is_active = true
    order by e.created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  return query
  with confirmed as (
    select part.batch_id, part.ticket_category_id, count(*)::integer as confirmed_count
    from public.participants part
    join public.payments pay on pay.participant_id = part.id
    where part.event_id = v_event_id
      and part.batch_id is not null
      and part.ticket_category_id is not null
      and coalesce(part.registration_status, 'pending') <> 'cancelled'
      and pay.payment_status = 'paid'
      and (part.reservation_status is null or part.reservation_status = 'confirmed')
    group by part.batch_id, part.ticket_category_id
  )
  select
    batch.id,
    batch.event_id,
    batch.name,
    batch.sequence_number,
    rbp.ticket_category_id,
    tc.name,
    rbp.male_price,
    rbp.female_price,
    rbp.max_confirmed_registrations,
    batch.starts_at,
    batch.ends_at,
    batch.is_active,
    coalesce(c.confirmed_count, 0) as confirmed_count,
    case
      when rbp.max_confirmed_registrations is null then null
      else greatest(rbp.max_confirmed_registrations - coalesce(c.confirmed_count, 0), 0)
    end::integer as remaining_slots,
    batch.created_at,
    batch.updated_at
  from public.registration_batches batch
  join public.registration_batch_prices rbp on rbp.batch_id = batch.id
  join public.ticket_categories tc on tc.id = rbp.ticket_category_id
  left join confirmed c on c.batch_id = batch.id and c.ticket_category_id = rbp.ticket_category_id
  where batch.event_id = v_event_id
  order by batch.sequence_number asc, tc.sort_order asc, tc.name asc;
end;
$$;

revoke all on function public.get_registration_batches(uuid) from public, anon, authenticated;
grant execute on function public.get_registration_batches(uuid) to authenticated;

-- ============================================================
-- 6. get_event_ticket_categories: lote atual de uma categoria passa a
--    considerar tambem a data de encerramento do lote.
-- ============================================================

create or replace function public.get_event_ticket_categories(
  p_event_id uuid default null
)
returns table (
  id uuid,
  event_id uuid,
  name text,
  slug text,
  description text,
  capacity integer,
  is_active boolean,
  sort_order integer,
  confirmed_count integer,
  pending_count integer,
  reserved_count integer,
  available_slots integer,
  current_batch_id uuid,
  current_batch_name text,
  current_batch_sequence integer,
  current_male_price numeric,
  current_female_price numeric,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid := p_event_id;
begin
  if v_event_id is null then
    select e.id into v_event_id
    from public.events e
    where e.is_active = true
    order by e.created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  return query
  with stats as (
    select
      p.ticket_category_id,
      count(*) filter (
        where coalesce(p.registration_status, 'pending') <> 'cancelled'
          and p.reservation_status = 'confirmed'
      )::integer as confirmed_count,
      count(*) filter (
        where coalesce(p.registration_status, 'pending') <> 'cancelled'
          and p.reservation_status = 'pending'
      )::integer as pending_count,
      count(*) filter (
        where coalesce(p.registration_status, 'pending') <> 'cancelled'
          and p.reservation_status in ('pending', 'confirmed')
      )::integer as reserved_count
    from public.participants p
    where p.event_id = v_event_id
      and p.ticket_category_id is not null
    group by p.ticket_category_id
  ),
  current_batch as (
    select distinct on (rbp.ticket_category_id)
      rbp.ticket_category_id,
      rb.id as batch_id,
      rb.name as batch_name,
      rb.sequence_number,
      rbp.male_price,
      rbp.female_price
    from public.registration_batch_prices rbp
    join public.registration_batches rb on rb.id = rbp.batch_id
    where rb.event_id = v_event_id
      and rb.is_active = true
      and (
        rbp.max_confirmed_registrations is null
        or coalesce((
          select count(*)::integer
          from public.participants part
          join public.payments pay on pay.participant_id = part.id
          where part.batch_id = rb.id
            and part.ticket_category_id = rbp.ticket_category_id
            and coalesce(part.registration_status, 'pending') <> 'cancelled'
            and pay.payment_status = 'paid'
            and (part.reservation_status is null or part.reservation_status = 'confirmed')
        ), 0) < rbp.max_confirmed_registrations
      )
      and (rb.ends_at is null or now() <= rb.ends_at)
    order by rbp.ticket_category_id, rb.sequence_number asc
  )
  select
    tc.id,
    tc.event_id,
    tc.name,
    tc.slug,
    tc.description,
    tc.capacity,
    tc.is_active,
    tc.sort_order,
    coalesce(s.confirmed_count, 0),
    coalesce(s.pending_count, 0),
    coalesce(s.reserved_count, 0),
    case
      when tc.capacity is null then null::integer
      else greatest(tc.capacity - coalesce(s.reserved_count, 0), 0)
    end::integer,
    cb.batch_id,
    cb.batch_name,
    cb.sequence_number,
    cb.male_price,
    cb.female_price,
    tc.created_at,
    tc.updated_at
  from public.ticket_categories tc
  left join stats s
    on s.ticket_category_id = tc.id
  left join current_batch cb
    on cb.ticket_category_id = tc.id
  where tc.event_id = v_event_id
  order by tc.sort_order asc, tc.name asc;
end;
$$;

revoke all on function public.get_event_ticket_categories(uuid) from public, anon, authenticated;
grant execute on function public.get_event_ticket_categories(uuid) to authenticated, anon;

-- ============================================================
-- 7. get_registration_pricing_preview: linha "sem row de preco" (categoria
--    indisponivel no lote) continua bloqueando; limite nulo deixa de
--    bloquear; esgotamento passa a considerar tambem a data do lote.
-- ============================================================

create or replace function public.get_registration_pricing_preview(
  p_gender text,
  p_coupon_code text default null,
  p_event_id uuid default null,
  p_ticket_category_id uuid default null
)
returns table (
  batch_id uuid,
  batch_name text,
  sequence_number integer,
  base_amount numeric,
  discount_amount numeric,
  final_amount numeric,
  remaining_slots integer,
  coupon_message text,
  coupon_type text,
  discount_percent numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid := p_event_id;
  v_batch public.registration_batches%rowtype;
  v_batch_category_limit integer;
  v_confirmed_count integer;
  v_gender_key text := lower(trim(coalesce(p_gender, '')));
  v_base numeric;
  v_discount numeric := 0;
  v_final numeric;
  v_coupon record;
  v_ticket_category_id uuid;
  v_open_bar_id uuid;
begin
  if v_event_id is null then
    select id into v_event_id
    from public.events
    where is_active = true
    order by created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  if p_ticket_category_id is not null then
    select tc.id into v_ticket_category_id
    from public.ticket_categories tc
    where tc.id = p_ticket_category_id
      and tc.event_id = v_event_id
      and tc.is_active = true
    limit 1;

    if v_ticket_category_id is null then
      raise exception 'Categoria de acesso invalida para o evento ativo.';
    end if;
  else
    select tc.id into v_open_bar_id
    from public.ticket_categories tc
    where tc.event_id = v_event_id
      and tc.slug = 'open-bar'
      and tc.is_active = true
    limit 1;

    if v_open_bar_id is not null then
      v_ticket_category_id := v_open_bar_id;
    else
      select tc.id into v_ticket_category_id
      from public.ticket_categories tc
      where tc.event_id = v_event_id
        and tc.is_active = true
      order by tc.sort_order asc, tc.name asc
      limit 1;
    end if;
  end if;

  if v_ticket_category_id is null then
    raise exception 'Nenhuma categoria de acesso ativa para o evento.';
  end if;

  select * into v_batch
  from public.registration_batches
  where event_id = v_event_id
    and is_active = true
  order by sequence_number asc
  limit 1;

  if not found then
    raise exception 'Nenhum lote ativo configurado para o evento.';
  end if;

  select rbp.max_confirmed_registrations into v_batch_category_limit
  from public.registration_batch_prices rbp
  where rbp.batch_id = v_batch.id
    and rbp.ticket_category_id = v_ticket_category_id;

  if not found then
    raise exception 'Categoria indisponivel no lote atual.';
  end if;

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = v_batch.id
    and part.ticket_category_id = v_ticket_category_id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  if (v_batch_category_limit is not null and v_confirmed_count >= v_batch_category_limit)
     or (v_batch.ends_at is not null and now() > v_batch.ends_at) then
    perform * from public.advance_registration_batch_if_needed(v_event_id);

    select * into v_batch
    from public.registration_batches
    where event_id = v_event_id
      and is_active = true
    order by sequence_number asc
    limit 1;

    if not found then
      raise exception 'Inscricoes encerradas ou lotes esgotados.';
    end if;

    select rbp.max_confirmed_registrations into v_batch_category_limit
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id;

    if not found then
      raise exception 'Categoria indisponivel no lote atual.';
    end if;

    select count(*)::integer into v_confirmed_count
    from public.participants part
    join public.payments pay
      on pay.participant_id = part.id
    where part.batch_id = v_batch.id
      and part.ticket_category_id = v_ticket_category_id
      and coalesce(part.registration_status, 'pending') <> 'cancelled'
      and pay.payment_status = 'paid'
      and (part.reservation_status is null or part.reservation_status = 'confirmed');

    if (v_batch_category_limit is not null and v_confirmed_count >= v_batch_category_limit)
       or (v_batch.ends_at is not null and now() > v_batch.ends_at) then
      raise exception 'Categoria esgotada neste lote.';
    end if;
  end if;

  if v_gender_key in ('feminino', 'female', 'f') then
    select round(rbp.female_price, 2) into v_base
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  elsif v_gender_key in ('masculino', 'male', 'm') then
    select round(rbp.male_price, 2) into v_base
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;

  if v_base is null then
    raise exception 'Preco nao configurado para esta categoria e lote.';
  end if;

  v_final := v_base;

  if coalesce(trim(p_coupon_code), '') <> '' then
    select * into v_coupon
    from public.validate_coupon(trim(p_coupon_code), v_event_id, v_base)
    limit 1;

    v_discount := round(coalesce(v_coupon.discount_amount, 0), 2);
    v_final := round(coalesce(v_coupon.final_amount, v_base), 2);

    return query
    select
      v_batch.id,
      v_batch.name,
      v_batch.sequence_number,
      v_base,
      v_discount,
      v_final,
      case when v_batch_category_limit is null then null::integer else greatest(v_batch_category_limit - v_confirmed_count, 0) end,
      coalesce(v_coupon.message, 'Cupom aplicado.'),
      coalesce(v_coupon.coupon_type, ''),
      coalesce(v_coupon.discount_percent, 0);

    return;
  end if;

  return query
  select
    v_batch.id,
    v_batch.name,
    v_batch.sequence_number,
    v_base,
    0::numeric,
    v_final,
    case when v_batch_category_limit is null then null::integer else greatest(v_batch_category_limit - v_confirmed_count, 0) end,
    null::text,
    null::text,
    0::numeric;
end;
$$;

-- ============================================================
-- 8. create_registration: mesma flexibilizacao aplicada em get_registration_pricing_preview.
-- ============================================================

create or replace function public.create_registration(
  p_full_name text,
  p_cpf text,
  p_birth_date date,
  p_gender text,
  p_phone text,
  p_email text,
  p_city text,
  p_shirt_type text,
  p_shirt_size text,
  p_registration_status text,
  p_notes text,
  p_payment_method text,
  p_payment_status text,
  p_event_id uuid,
  p_coupon_code text default null,
  p_ticket_category_id uuid default null
)
returns table(
  participant_id uuid,
  full_name text,
  batch_name text,
  base_amount numeric,
  discount_amount numeric,
  final_amount numeric,
  payment_status text,
  reservation_expires_at timestamptz,
  shirt_type text,
  shirt_size text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_inventory public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_participant_id uuid;
  v_event_id uuid := p_event_id;
  v_event public.events%rowtype;
  v_payment_status text := coalesce(nullif(trim(p_payment_status), ''), 'pending');
  v_payment_method text := coalesce(nullif(trim(p_payment_method), ''), 'pix');
  v_reservation_status text;
  v_reservation_expires_at timestamptz;
  v_batch public.registration_batches%rowtype;
  v_batch_category_limit integer;
  v_confirmed_count integer;
  v_gender_key text := lower(trim(coalesce(p_gender, '')));
  v_base_amount numeric;
  v_discount_amount numeric := 0;
  v_final_amount numeric;
  v_coupon record;
  v_coupon_type text;
  v_ticket_category_id uuid;
  v_ticket_category_capacity integer;
  v_category_reserved_count integer;
  v_has_shirt_item boolean := false;
  v_enforce_physical_stock boolean := false;
  v_shirt_type text;
  v_shirt_size text;
  v_kit_item public.event_kit_items%rowtype;
begin
  if v_event_id is null then
    select e.id
      into v_event_id
    from public.events e
    where e.is_active = true
    order by e.created_at desc
    limit 1;
  end if;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
  end if;

  select e.*
    into v_event
  from public.events e
  where e.id = v_event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.registration_enabled, false) then
    raise exception 'Inscricoes fechadas para este evento.';
  end if;

  if coalesce(v_event.min_age, 0) > 0
     and date_part('year', age(p_birth_date)) < v_event.min_age then
    raise exception 'Idade minima de % anos exigida para este evento.', v_event.min_age;
  end if;

  v_enforce_physical_stock := coalesce(v_event.limit_shirt_selection_to_stock, false);

  select exists (
    select 1
    from public.event_kit_items eki
    where eki.event_id = v_event_id
      and eki.item_type = 'shirt'
      and eki.is_active = true
  )
  into v_has_shirt_item;

  select p.id
    into v_participant_id
  from public.participants p
  where p.cpf = p_cpf
    and p.event_id = v_event_id
  order by p.created_at asc
  limit 1
  for update;

  if p_ticket_category_id is not null then
    select tc.id, tc.capacity
      into v_ticket_category_id, v_ticket_category_capacity
    from public.ticket_categories tc
    where tc.id = p_ticket_category_id
      and tc.event_id = v_event_id
      and tc.is_active = true
    limit 1;

    if v_ticket_category_id is null then
      raise exception 'Categoria de acesso invalida para o evento ativo.';
    end if;
  else
    select tc.id, tc.capacity
      into v_ticket_category_id, v_ticket_category_capacity
    from public.ticket_categories tc
    where tc.event_id = v_event_id
      and tc.slug = 'open-bar'
      and tc.is_active = true
    limit 1;

    if v_ticket_category_id is null then
      select tc.id, tc.capacity
        into v_ticket_category_id, v_ticket_category_capacity
      from public.ticket_categories tc
      where tc.event_id = v_event_id
        and tc.is_active = true
      order by tc.sort_order asc, tc.name asc
      limit 1;
    end if;
  end if;

  if v_ticket_category_id is null then
    raise exception 'Nenhuma categoria de acesso ativa para o evento.';
  end if;

  select count(*)::integer
    into v_category_reserved_count
  from public.participants p
  where p.event_id = v_event_id
    and p.ticket_category_id = v_ticket_category_id
    and coalesce(p.registration_status, 'pending') <> 'cancelled'
    and p.reservation_status in ('pending', 'confirmed');

  if v_ticket_category_capacity is not null
     and v_category_reserved_count >= v_ticket_category_capacity then
    raise exception 'Capacidade da categoria de acesso atingida.';
  end if;

  v_shirt_type := coalesce(nullif(trim(p_shirt_type), ''), 'Sem camiseta');
  v_shirt_size := coalesce(nullif(trim(p_shirt_size), ''), 'N/A');

  if v_has_shirt_item then
    if coalesce(trim(p_shirt_type), '') = ''
       or coalesce(trim(p_shirt_size), '') = '' then
      raise exception 'Camiseta obrigatoria para este evento.';
    end if;

    if v_enforce_physical_stock then
      select si.*
        into v_inventory
      from public.shirt_inventory si
      where si.event_id = v_event_id
        and si.shirt_type = v_shirt_type
        and si.shirt_size = v_shirt_size
      for update;

      if not found then
        raise exception 'Estoque nao encontrado para este modelo e tamanho.';
      end if;

      v_available_stock :=
        coalesce(v_inventory.total_quantity, 0)
        - coalesce(v_inventory.reserved_quantity, 0)
        - coalesce(v_inventory.delivered_quantity, 0);

      if v_available_stock <= 0 then
        raise exception 'Estoque indisponivel para este modelo e tamanho.';
      end if;
    end if;
  end if;

  select * into v_batch
  from public.registration_batches
  where event_id = v_event_id
    and is_active = true
  order by sequence_number asc
  limit 1
  for update;

  if not found then
    raise exception 'Inscricoes encerradas ou lotes esgotados.';
  end if;

  select rbp.max_confirmed_registrations into v_batch_category_limit
  from public.registration_batch_prices rbp
  where rbp.batch_id = v_batch.id
    and rbp.ticket_category_id = v_ticket_category_id;

  if not found then
    raise exception 'Categoria indisponivel no lote atual.';
  end if;

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = v_batch.id
    and part.ticket_category_id = v_ticket_category_id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  if (v_batch_category_limit is not null and v_confirmed_count >= v_batch_category_limit)
     or (v_batch.ends_at is not null and now() > v_batch.ends_at) then
    perform * from public.advance_registration_batch_if_needed(v_event_id);

    select * into v_batch
    from public.registration_batches
    where event_id = v_event_id
      and is_active = true
    order by sequence_number asc
    limit 1
    for update;

    if not found then
      raise exception 'Inscricoes encerradas ou lotes esgotados.';
    end if;

    select rbp.max_confirmed_registrations into v_batch_category_limit
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id;

    if not found then
      raise exception 'Categoria indisponivel no lote atual.';
    end if;

    select count(*)::integer into v_confirmed_count
    from public.participants part
    join public.payments pay
      on pay.participant_id = part.id
    where part.batch_id = v_batch.id
      and part.ticket_category_id = v_ticket_category_id
      and coalesce(part.registration_status, 'pending') <> 'cancelled'
      and pay.payment_status = 'paid'
      and (part.reservation_status is null or part.reservation_status = 'confirmed');

    if (v_batch_category_limit is not null and v_confirmed_count >= v_batch_category_limit)
       or (v_batch.ends_at is not null and now() > v_batch.ends_at) then
      raise exception 'Categoria esgotada neste lote.';
    end if;
  end if;

  if v_gender_key in ('feminino', 'female', 'f') then
    select round(rbp.female_price, 2)
      into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  elsif v_gender_key in ('masculino', 'male', 'm') then
    select round(rbp.male_price, 2)
      into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;

  if v_base_amount is null then
    raise exception 'Preco nao configurado para esta categoria e lote.';
  end if;

  v_final_amount := v_base_amount;

  if lower(v_payment_method) = 'courtesy' then
    v_payment_status := 'paid';
    v_payment_method := 'courtesy';
  end if;

  if coalesce(trim(p_coupon_code), '') <> '' then
    select vc.*
      into v_coupon
    from public.validate_coupon(trim(p_coupon_code), v_event_id, v_base_amount) vc
    limit 1;

    v_coupon_type := v_coupon.coupon_type;
    v_discount_amount := round(coalesce(v_coupon.discount_amount, 0), 2);
    v_final_amount := round(coalesce(v_coupon.final_amount, v_base_amount), 2);

    if coalesce(v_coupon_type, '') = 'courtesy' then
      v_payment_status := 'paid';
      v_payment_method := 'courtesy';
    end if;
  end if;

  if v_has_shirt_item and v_enforce_physical_stock then
    update public.shirt_inventory si
    set reserved_quantity = coalesce(si.reserved_quantity, 0) + 1,
        updated_at = now()
    where si.id = v_inventory.id;

    insert into public.inventory_movements (
      event_id,
      inventory_id,
      movement_type,
      quantity,
      notes
    ) values (
      v_event_id,
      v_inventory.id,
      'adjustment',
      -1,
      format('Reserva de inscricao %s (%s).', p_full_name, p_cpf)
    );
  end if;

  if v_payment_status = 'paid' then
    v_reservation_status := 'confirmed';
    v_reservation_expires_at := null;
  else
    v_reservation_status := 'pending';
    v_reservation_expires_at := now() + interval '2 hours';
  end if;

  if v_participant_id is null then
    insert into public.participants (
      event_id,
      full_name,
      cpf,
      birth_date,
      gender,
      phone,
      email,
      city,
      shirt_type,
      shirt_size,
      registration_status,
      notes,
      reservation_status,
      reservation_expires_at,
      reservation_released_at,
      batch_id,
      base_amount,
      discount_amount,
      final_amount,
      ticket_category_id
    ) values (
      v_event_id,
      p_full_name,
      p_cpf,
      p_birth_date,
      p_gender,
      p_phone,
      p_email,
      p_city,
      v_shirt_type,
      v_shirt_size,
      coalesce(
        nullif(trim(p_registration_status), ''),
        case when v_payment_status = 'paid' then 'confirmed' else 'pending' end
      ),
      p_notes,
      v_reservation_status,
      v_reservation_expires_at,
      null,
      v_batch.id,
      v_base_amount,
      v_discount_amount,
      v_final_amount,
      v_ticket_category_id
    )
    returning public.participants.id into v_participant_id;
  else
    update public.participants p
    set full_name = p_full_name,
        cpf = p_cpf,
        birth_date = p_birth_date,
        gender = p_gender,
        phone = p_phone,
        email = p_email,
        city = p_city,
        shirt_type = v_shirt_type,
        shirt_size = v_shirt_size,
        registration_status = coalesce(
          nullif(trim(p_registration_status), ''),
          case when v_payment_status = 'paid' then 'confirmed' else 'pending' end
        ),
        notes = p_notes,
        reservation_status = v_reservation_status,
        reservation_expires_at = v_reservation_expires_at,
        reservation_released_at = null,
        batch_id = v_batch.id,
        base_amount = v_base_amount,
        discount_amount = v_discount_amount,
        final_amount = v_final_amount,
        ticket_category_id = v_ticket_category_id,
        updated_at = now()
    where p.id = v_participant_id;
  end if;

  insert into public.payments (
    participant_id,
    event_id,
    amount,
    discount_amount,
    final_amount,
    payment_method,
    payment_status,
    paid_at,
    expires_at
  ) values (
    v_participant_id,
    v_event_id,
    v_base_amount,
    v_discount_amount,
    v_final_amount,
    v_payment_method,
    v_payment_status,
    case when v_payment_status = 'paid' then now() else null end,
    case when v_payment_status = 'paid' then null else v_reservation_expires_at end
  );

  if coalesce(v_event.kit_enabled, false) then
    for v_kit_item in
      select eki.*
      from public.event_kit_items eki
      where eki.event_id = v_event_id
        and eki.is_active = true
      order by eki.sort_order asc, eki.created_at asc
    loop
      insert into public.participant_kit_items (
        participant_id,
        event_id,
        kit_item_id,
        variant_data,
        quantity,
        status
      ) values (
        v_participant_id,
        v_event_id,
        v_kit_item.id,
        case
          when v_kit_item.item_type = 'shirt'
            then jsonb_build_object(
              'shirt_type', v_shirt_type,
              'shirt_size', v_shirt_size
            )
          else null
        end,
        v_kit_item.quantity_per_participant,
        case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end
      )
      on conflict on constraint participant_kit_items_participant_kit_unique
      do update set
        event_id = excluded.event_id,
        quantity = excluded.quantity,
        status = excluded.status,
        variant_data = excluded.variant_data;
    end loop;
  end if;

  return query
  select
    v_participant_id,
    p_full_name,
    v_batch.name,
    v_base_amount,
    v_discount_amount,
    v_final_amount,
    v_payment_status,
    v_reservation_expires_at,
    v_shirt_type,
    v_shirt_size;
end;
$function$;

grant execute on function public.create_registration(
  text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid
) to authenticated;

grant execute on function public.create_registration(
  text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid
) to anon;

-- ============================================================
-- 9. confirm_registration_payment: checagem de esgotamento por categoria
--    passa a considerar tambem a data do lote.
-- ============================================================

create or replace function public.confirm_registration_payment(
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_inventory public.shirt_inventory%rowtype;
  v_available integer;
  v_re_reserved boolean := false;
  v_batch public.registration_batches%rowtype;
  v_batch_category_limit integer;
  v_confirmed_count integer;
  v_category_capacity integer;
  v_category_confirmed_count integer;
  v_category_reserved_count integer;
begin
  if p_participant_id is null then
    raise exception 'ID do participante e obrigatorio.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select * into v_payment
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o participante.';
  end if;

  if v_participant.ticket_category_id is not null then
    select tc.capacity into v_category_capacity
    from public.ticket_categories tc
    where tc.id = v_participant.ticket_category_id
      and tc.event_id = v_participant.event_id
    limit 1;

    select count(*)::integer into v_category_confirmed_count
    from public.participants p
    where p.event_id = v_participant.event_id
      and p.ticket_category_id = v_participant.ticket_category_id
      and coalesce(p.registration_status, 'pending') <> 'cancelled'
      and p.reservation_status = 'confirmed'
      and p.id <> v_participant.id;

    if v_category_capacity is not null and v_category_confirmed_count >= v_category_capacity then
      raise exception 'Capacidade da categoria de acesso atingida para confirmacao.';
    end if;
  end if;

  if v_payment.payment_status = 'paid'
     and v_participant.reservation_status = 'confirmed' then
    perform * from public.advance_registration_batch_if_needed(v_participant.event_id);
    return true;
  end if;

  if v_participant.batch_id is not null and v_participant.ticket_category_id is not null then
    select * into v_batch
    from public.registration_batches
    where id = v_participant.batch_id
    for update;

    if found then
      select rbp.max_confirmed_registrations into v_batch_category_limit
      from public.registration_batch_prices rbp
      where rbp.batch_id = v_batch.id
        and rbp.ticket_category_id = v_participant.ticket_category_id;

      if v_batch_category_limit is not null or v_batch.ends_at is not null then
        select count(*)::integer into v_confirmed_count
        from public.participants part
        join public.payments pay
          on pay.participant_id = part.id
        where part.batch_id = v_batch.id
          and part.ticket_category_id = v_participant.ticket_category_id
          and coalesce(part.registration_status, 'pending') <> 'cancelled'
          and pay.payment_status = 'paid'
          and (part.reservation_status is null or part.reservation_status = 'confirmed');

        if (v_batch_category_limit is not null and v_confirmed_count >= v_batch_category_limit)
           or (v_batch.ends_at is not null and now() > v_batch.ends_at) then
          perform * from public.advance_registration_batch_if_needed(v_participant.event_id);
          raise exception 'Categoria esgotada no lote % para confirmacao de novas inscricoes.', v_batch.name;
        end if;
      end if;
    end if;
  end if;

  if v_participant.reservation_status in ('expired', 'released') then
    if v_participant.ticket_category_id is not null then
      select tc.capacity into v_category_capacity
      from public.ticket_categories tc
      where tc.id = v_participant.ticket_category_id
        and tc.event_id = v_participant.event_id
      limit 1;

      select count(*)::integer into v_category_reserved_count
      from public.participants p
      where p.event_id = v_participant.event_id
        and p.ticket_category_id = v_participant.ticket_category_id
        and coalesce(p.registration_status, 'pending') <> 'cancelled'
        and p.reservation_status in ('pending', 'confirmed');

      if v_category_capacity is not null and v_category_reserved_count >= v_category_capacity then
        raise exception 'Categoria sem vagas disponiveis para reativar reserva.';
      end if;
    end if;

    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para o modelo/tamanho do participante.';
    end if;

    v_available := v_inventory.total_quantity - v_inventory.reserved_quantity - v_inventory.delivered_quantity;
    if v_available <= 0 then
      raise exception 'Reserva expirada e sem estoque disponivel para reativar. Revisao manual necessaria.';
    end if;

    update public.shirt_inventory
    set reserved_quantity = reserved_quantity + 1,
        updated_at = now()
    where id = v_inventory.id;

    v_re_reserved := true;
  end if;

  update public.participants
  set registration_status = 'confirmed',
      reservation_status = 'confirmed',
      reservation_expires_at = null,
      reservation_released_at = null,
      updated_at = now()
  where id = p_participant_id;

  update public.payments
  set payment_status = 'paid',
      paid_at = now(),
      expires_at = null
  where participant_id = p_participant_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_payment_confirmed',
    'participants',
    p_participant_id,
    jsonb_build_object(
      're_reserved', v_re_reserved,
      'shirt_type', v_participant.shirt_type,
      'shirt_size', v_participant.shirt_size,
      'batch_id', v_participant.batch_id,
      'ticket_category_id', v_participant.ticket_category_id
    ),
    v_participant.event_id
  );

  perform * from public.advance_registration_batch_if_needed(v_participant.event_id);

  return true;
end;
$$;

commit;
