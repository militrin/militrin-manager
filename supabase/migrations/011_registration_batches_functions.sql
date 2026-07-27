-- 011_registration_batches_functions.sql
-- Funcoes de lote ativo, virada automatica, precificacao e integracao na inscricao.

create or replace function public.get_active_registration_batch()
returns table (
  batch_id uuid,
  batch_name text,
  sequence_number integer,
  male_price numeric,
  female_price numeric,
  confirmed_count integer,
  max_confirmed_registrations integer,
  remaining_slots integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_batch public.registration_batches%rowtype;
  v_confirmed_count integer;
begin
  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is null then
    raise exception 'Nenhum evento ativo encontrado.';
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

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = v_batch.id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  return query
  select
    v_batch.id,
    v_batch.name,
    v_batch.sequence_number,
    v_batch.male_price,
    v_batch.female_price,
    v_confirmed_count,
    v_batch.max_confirmed_registrations,
    greatest(v_batch.max_confirmed_registrations - v_confirmed_count, 0)::integer;
end;
$$;

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
  v_confirmed_count integer;
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

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = v_current.id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  if v_confirmed_count < v_current.max_confirmed_registrations then
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
      'new_sequence', v_next.sequence_number,
      'confirmed_count', v_confirmed_count,
      'max_confirmed_registrations', v_current.max_confirmed_registrations
    ),
    v_event_id
  );

  return query select true, v_current.id, v_next.id, 'Lote avancado automaticamente.';
end;
$$;

create or replace function public.get_registration_batches(
  p_event_id uuid default null
)
returns table (
  id uuid,
  event_id uuid,
  name text,
  sequence_number integer,
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
    select
      part.batch_id,
      count(*)::integer as confirmed_count
    from public.participants part
    join public.payments pay
      on pay.participant_id = part.id
    where part.event_id = v_event_id
      and part.batch_id is not null
      and coalesce(part.registration_status, 'pending') <> 'cancelled'
      and pay.payment_status = 'paid'
      and (part.reservation_status is null or part.reservation_status = 'confirmed')
    group by part.batch_id
  )
  select
    batch.id,
    batch.event_id,
    batch.name,
    batch.sequence_number,
    batch.male_price,
    batch.female_price,
    batch.max_confirmed_registrations,
    batch.starts_at,
    batch.ends_at,
    batch.is_active,
    coalesce(c.confirmed_count, 0) as confirmed_count,
    greatest(batch.max_confirmed_registrations - coalesce(c.confirmed_count, 0), 0)::integer as remaining_slots,
    batch.created_at,
    batch.updated_at
  from public.registration_batches batch
  left join confirmed c on c.batch_id = batch.id
  where batch.event_id = v_event_id
  order by batch.sequence_number asc;
end;
$$;

create or replace function public.create_registration_batch(
  p_event_id uuid,
  p_name text,
  p_sequence_number integer,
  p_male_price numeric,
  p_female_price numeric,
  p_max_confirmed_registrations integer,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_is_active boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do lote obrigatorio.';
  end if;

  if p_sequence_number is null then
    raise exception 'Numero de sequencia obrigatorio.';
  end if;

  if p_male_price is null or p_male_price < 0 or p_female_price is null or p_female_price < 0 then
    raise exception 'Precos do lote devem ser maiores ou iguais a zero.';
  end if;

  if p_max_confirmed_registrations is null or p_max_confirmed_registrations <= 0 then
    raise exception 'Limite do lote deve ser maior que zero.';
  end if;

  if p_starts_at is not null and p_ends_at is not null and p_starts_at > p_ends_at then
    raise exception 'Janela de datas invalida para o lote.';
  end if;

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
    trim(p_name),
    p_sequence_number,
    round(p_male_price, 2),
    round(p_female_price, 2),
    p_max_confirmed_registrations,
    p_starts_at,
    p_ends_at,
    coalesce(p_is_active, false)
  ) returning id into v_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_created',
    'registration_batches',
    v_id,
    jsonb_build_object(
      'name', trim(p_name),
      'sequence_number', p_sequence_number,
      'male_price', round(p_male_price, 2),
      'female_price', round(p_female_price, 2),
      'max_confirmed_registrations', p_max_confirmed_registrations,
      'is_active', coalesce(p_is_active, false)
    ),
    p_event_id
  );

  return v_id;
end;
$$;

create or replace function public.update_registration_batch(
  p_batch_id uuid,
  p_event_id uuid,
  p_name text,
  p_sequence_number integer,
  p_male_price numeric,
  p_female_price numeric,
  p_max_confirmed_registrations integer,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_is_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch public.registration_batches%rowtype;
  v_confirmed_count integer;
  v_has_registrations boolean;
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

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do lote obrigatorio.';
  end if;

  if p_sequence_number is null then
    raise exception 'Numero de sequencia obrigatorio.';
  end if;

  if p_male_price is null or p_male_price < 0 or p_female_price is null or p_female_price < 0 then
    raise exception 'Precos do lote devem ser maiores ou iguais a zero.';
  end if;

  if p_max_confirmed_registrations is null or p_max_confirmed_registrations <= 0 then
    raise exception 'Limite do lote deve ser maior que zero.';
  end if;

  if p_starts_at is not null and p_ends_at is not null and p_starts_at > p_ends_at then
    raise exception 'Janela de datas invalida para o lote.';
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

  select exists (
    select 1
    from public.participants p
    where p.batch_id = p_batch_id
  ) into v_has_registrations;

  if v_has_registrations then
    if round(p_male_price, 2) <> round(v_batch.male_price, 2)
       or round(p_female_price, 2) <> round(v_batch.female_price, 2) then
      raise exception 'Nao e permitido alterar preco de lote ja utilizado.';
    end if;
  end if;

  if coalesce(p_is_active, false) then
    update public.registration_batches
    set is_active = false,
        updated_at = now()
    where event_id = p_event_id
      and id <> p_batch_id;
  end if;

  update public.registration_batches
  set
    name = trim(p_name),
    sequence_number = p_sequence_number,
    male_price = round(p_male_price, 2),
    female_price = round(p_female_price, 2),
    max_confirmed_registrations = p_max_confirmed_registrations,
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    is_active = coalesce(p_is_active, false),
    updated_at = now()
  where id = p_batch_id
    and event_id = p_event_id;

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
      'name', trim(p_name),
      'sequence_number', p_sequence_number,
      'male_price', round(p_male_price, 2),
      'female_price', round(p_female_price, 2),
      'max_confirmed_registrations', p_max_confirmed_registrations,
      'is_active', coalesce(p_is_active, false)
    ),
    p_event_id
  );

  return true;
end;
$$;

create or replace function public.delete_registration_batch(
  p_batch_id uuid,
  p_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_has_registrations boolean;
begin
  if p_batch_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select exists (
    select 1
    from public.participants p
    where p.batch_id = p_batch_id
  ) into v_has_registrations;

  if v_has_registrations then
    raise exception 'Nao e permitido apagar lote com inscricoes vinculadas.';
  end if;

  delete from public.registration_batches
  where id = p_batch_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Lote nao encontrado para o evento.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_deleted',
    'registration_batches',
    p_batch_id,
    '{}'::jsonb,
    p_event_id
  );

  return true;
end;
$$;

create or replace function public.activate_registration_batch(
  p_batch_id uuid,
  p_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch public.registration_batches%rowtype;
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

  update public.registration_batches
  set is_active = false,
      updated_at = now()
  where event_id = p_event_id
    and id <> p_batch_id;

  update public.registration_batches
  set is_active = true,
      updated_at = now()
  where id = p_batch_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_batch_activated',
    'registration_batches',
    p_batch_id,
    jsonb_build_object('sequence_number', v_batch.sequence_number),
    p_event_id
  );

  return true;
end;
$$;

create or replace function public.get_registration_pricing_preview(
  p_gender text,
  p_coupon_code text default null,
  p_event_id uuid default null
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
  v_confirmed_count integer;
  v_gender_key text := lower(trim(coalesce(p_gender, '')));
  v_base numeric;
  v_discount numeric := 0;
  v_final numeric;
  v_coupon record;
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

  select * into v_batch
  from public.registration_batches
  where event_id = v_event_id
    and is_active = true
  order by sequence_number asc
  limit 1;

  if not found then
    raise exception 'Nenhum lote ativo configurado para o evento.';
  end if;

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = v_batch.id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  if v_confirmed_count >= v_batch.max_confirmed_registrations then
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

    select count(*)::integer into v_confirmed_count
    from public.participants part
    join public.payments pay
      on pay.participant_id = part.id
    where part.batch_id = v_batch.id
      and coalesce(part.registration_status, 'pending') <> 'cancelled'
      and pay.payment_status = 'paid'
      and (part.reservation_status is null or part.reservation_status = 'confirmed');

    if v_confirmed_count >= v_batch.max_confirmed_registrations then
      raise exception 'Inscricoes encerradas ou lotes esgotados.';
    end if;
  end if;

  if v_gender_key in ('feminino', 'female', 'f') then
    v_base := round(v_batch.female_price, 2);
  elsif v_gender_key in ('masculino', 'male', 'm') then
    v_base := round(v_batch.male_price, 2);
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
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
      greatest(v_batch.max_confirmed_registrations - v_confirmed_count, 0)::integer,
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
    greatest(v_batch.max_confirmed_registrations - v_confirmed_count, 0)::integer,
    null::text,
    null::text,
    0::numeric;
end;
$$;

drop function if exists public.create_registration(
  text,
  text,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  text
);

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
  p_coupon_code text default null
)
returns table (
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
set search_path = public, pg_temp
as $$
declare
  v_inventory public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_participant_id uuid;
  v_event_id uuid := p_event_id;
  v_payment_status text := 'pending';
  v_payment_method text := p_payment_method;
  v_reservation_status text;
  v_reservation_expires_at timestamptz;
  v_batch public.registration_batches%rowtype;
  v_confirmed_count integer;
  v_gender_key text := lower(trim(coalesce(p_gender, '')));
  v_base_amount numeric;
  v_discount_amount numeric := 0;
  v_final_amount numeric;
  v_coupon record;
  v_coupon_id uuid;
  v_coupon_type text;
  v_coupon_discount_percent numeric := 0;
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

  if exists (
    select 1
    from public.participants
    where cpf = p_cpf and event_id = v_event_id
  ) then
    raise exception 'CPF ja cadastrado para o evento ativo.';
  end if;

  select *
  into v_inventory
  from public.shirt_inventory
  where event_id = v_event_id
    and shirt_type = p_shirt_type
    and shirt_size = p_shirt_size
  for update;

  if not found then
    raise exception 'Estoque nao encontrado para este modelo e tamanho.';
  end if;

  v_available_stock := v_inventory.total_quantity - v_inventory.reserved_quantity - v_inventory.delivered_quantity;

  if v_available_stock <= 0 then
    raise exception 'Estoque indisponivel para este modelo e tamanho.';
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

  select count(*)::integer into v_confirmed_count
  from public.participants part
  join public.payments pay
    on pay.participant_id = part.id
  where part.batch_id = v_batch.id
    and coalesce(part.registration_status, 'pending') <> 'cancelled'
    and pay.payment_status = 'paid'
    and (part.reservation_status is null or part.reservation_status = 'confirmed');

  if v_confirmed_count >= v_batch.max_confirmed_registrations then
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

    select count(*)::integer into v_confirmed_count
    from public.participants part
    join public.payments pay
      on pay.participant_id = part.id
    where part.batch_id = v_batch.id
      and coalesce(part.registration_status, 'pending') <> 'cancelled'
      and pay.payment_status = 'paid'
      and (part.reservation_status is null or part.reservation_status = 'confirmed');

    if v_confirmed_count >= v_batch.max_confirmed_registrations then
      raise exception 'Inscricoes encerradas ou lotes esgotados.';
    end if;
  end if;

  if v_gender_key in ('feminino', 'female', 'f') then
    v_base_amount := round(v_batch.female_price, 2);
  elsif v_gender_key in ('masculino', 'male', 'm') then
    v_base_amount := round(v_batch.male_price, 2);
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;

  v_final_amount := v_base_amount;

  if coalesce(trim(p_coupon_code), '') <> '' then
    select * into v_coupon
    from public.validate_coupon(trim(p_coupon_code), v_event_id, v_base_amount)
    limit 1;

    v_coupon_id := v_coupon.coupon_id;
    v_coupon_type := v_coupon.coupon_type;
    v_coupon_discount_percent := coalesce(v_coupon.discount_percent, 0);
    v_discount_amount := round(coalesce(v_coupon.discount_amount, 0), 2);
    v_final_amount := round(coalesce(v_coupon.final_amount, v_base_amount), 2);

    if coalesce(v_coupon_type, '') = 'courtesy' then
      v_payment_status := 'paid';
      v_payment_method := 'courtesy';
    end if;
  end if;

  update public.shirt_inventory
  set reserved_quantity = reserved_quantity + 1,
      updated_at = now()
  where id = v_inventory.id;

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

  if v_payment_status = 'paid' then
    v_reservation_status := 'confirmed';
    v_reservation_expires_at := null;
  else
    v_reservation_status := 'pending';
    v_reservation_expires_at := now() + interval '2 hours';
  end if;

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
    final_amount
  ) values (
    v_event_id,
    p_full_name,
    p_cpf,
    p_birth_date,
    p_gender,
    p_phone,
    p_email,
    p_city,
    p_shirt_type,
    p_shirt_size,
    coalesce(p_registration_status, case when v_payment_status = 'paid' then 'confirmed' else 'pending' end),
    p_notes,
    v_reservation_status,
    v_reservation_expires_at,
    null,
    v_batch.id,
    v_base_amount,
    v_discount_amount,
    v_final_amount
  ) returning id into v_participant_id;

  insert into public.payments (
    participant_id,
    event_id,
    amount,
    payment_method,
    payment_status,
    paid_at
  ) values (
    v_participant_id,
    v_event_id,
    v_final_amount,
    v_payment_method,
    v_payment_status,
    case when v_payment_status = 'paid' then now() else null end
  );

  if v_coupon_id is not null then
    update public.coupons
    set used_count = used_count + 1,
        updated_at = now()
    where id = v_coupon_id;

    insert into public.coupon_redemptions (
      coupon_id,
      participant_id,
      event_id,
      original_amount,
      discount_amount,
      final_amount
    ) values (
      v_coupon_id,
      v_participant_id,
      v_event_id,
      v_base_amount,
      v_discount_amount,
      v_final_amount
    );

    insert into public.audit_logs (
      action,
      entity_type,
      entity_id,
      details,
      event_id
    ) values (
      'coupon_redeemed',
      'participants',
      v_participant_id,
      jsonb_build_object(
        'coupon_id', v_coupon_id,
        'coupon_type', v_coupon_type,
        'discount_percent', v_coupon_discount_percent,
        'base_amount', v_base_amount,
        'discount_amount', v_discount_amount,
        'final_amount', v_final_amount
      ),
      v_event_id
    );
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'registration_created',
    'participants',
    v_participant_id,
    jsonb_build_object(
      'shirt_type', p_shirt_type,
      'shirt_size', p_shirt_size,
      'payment_status', v_payment_status,
      'reservation_status', v_reservation_status,
      'reservation_expires_at', v_reservation_expires_at,
      'batch_id', v_batch.id,
      'batch_name', v_batch.name,
      'sequence_number', v_batch.sequence_number,
      'base_amount', v_base_amount,
      'discount_amount', v_discount_amount,
      'final_amount', v_final_amount
    ),
    v_event_id
  );

  if v_payment_status = 'paid' then
    perform * from public.advance_registration_batch_if_needed(v_event_id);
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
    p_shirt_type,
    p_shirt_size;
end;
$$;

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
  v_confirmed_count integer;
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

  if v_payment.payment_status = 'paid'
     and v_participant.reservation_status = 'confirmed' then
    perform * from public.advance_registration_batch_if_needed(v_participant.event_id);
    return true;
  end if;

  if v_participant.batch_id is not null then
    select * into v_batch
    from public.registration_batches
    where id = v_participant.batch_id
    for update;

    if found then
      select count(*)::integer into v_confirmed_count
      from public.participants part
      join public.payments pay
        on pay.participant_id = part.id
      where part.batch_id = v_batch.id
        and coalesce(part.registration_status, 'pending') <> 'cancelled'
        and pay.payment_status = 'paid'
        and (part.reservation_status is null or part.reservation_status = 'confirmed');

      if v_confirmed_count >= v_batch.max_confirmed_registrations then
        perform * from public.advance_registration_batch_if_needed(v_participant.event_id);
        raise exception 'Lote % esgotado para confirmacao de novas inscricoes.', v_batch.name;
      end if;
    end if;
  end if;

  if v_participant.reservation_status in ('expired', 'released') then
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
      paid_at = now()
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
      'batch_id', v_participant.batch_id
    ),
    v_participant.event_id
  );

  perform * from public.advance_registration_batch_if_needed(v_participant.event_id);

  return true;
end;
$$;

