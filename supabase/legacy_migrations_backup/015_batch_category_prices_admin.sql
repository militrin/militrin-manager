-- 015_batch_category_prices_admin.sql
-- Integracao administrativa de precos por categoria em lotes.

insert into public.registration_batch_prices (
  batch_id,
  ticket_category_id,
  male_price,
  female_price
)
select
  rb.id,
  tc.id,
  rb.male_price,
  rb.female_price
from public.registration_batches rb
join public.ticket_categories tc
  on tc.event_id = rb.event_id
 and tc.slug = 'open-bar'
where not exists (
  select 1
  from public.registration_batch_prices rbp
  where rbp.batch_id = rb.id
    and rbp.ticket_category_id = tc.id
)
on conflict (batch_id, ticket_category_id) do nothing;

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
  v_count integer := 0;
  v_deleted integer := 0;
begin
  if p_batch_id is null or p_event_id is null then
    raise exception 'Batch e evento sao obrigatorios.';
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
    v_male_price := coalesce((v_item->>'male_price')::numeric, 0);
    v_female_price := coalesce((v_item->>'female_price')::numeric, 0);

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

    insert into public.registration_batch_prices (
      batch_id,
      ticket_category_id,
      male_price,
      female_price
    )
    values (
      p_batch_id,
      v_ticket_category_id,
      round(v_male_price, 2),
      round(v_female_price, 2)
    )
    on conflict (batch_id, ticket_category_id)
    do update set
      male_price = excluded.male_price,
      female_price = excluded.female_price,
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

create or replace function public.create_registration_batch_with_prices(
  p_event_id uuid,
  p_name text,
  p_sequence_number integer,
  p_male_price numeric,
  p_female_price numeric,
  p_max_confirmed_registrations integer,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
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
begin
  v_batch_id := public.create_registration_batch(
    p_event_id,
    p_name,
    p_sequence_number,
    p_male_price,
    p_female_price,
    p_max_confirmed_registrations,
    p_starts_at,
    p_ends_at,
    p_is_active
  );

  perform public.upsert_registration_batch_prices(
    v_batch_id,
    p_event_id,
    coalesce(p_prices, '[]'::jsonb)
  );

  return v_batch_id;
end;
$$;

create or replace function public.update_registration_batch_with_prices(
  p_batch_id uuid,
  p_event_id uuid,
  p_name text,
  p_sequence_number integer,
  p_male_price numeric,
  p_female_price numeric,
  p_max_confirmed_registrations integer,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_is_active boolean,
  p_prices jsonb default '[]'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.update_registration_batch(
    p_batch_id,
    p_event_id,
    p_name,
    p_sequence_number,
    p_male_price,
    p_female_price,
    p_max_confirmed_registrations,
    p_starts_at,
    p_ends_at,
    p_is_active
  );

  perform public.upsert_registration_batch_prices(
    p_batch_id,
    p_event_id,
    coalesce(p_prices, '[]'::jsonb)
  );

  return true;
end;
$$;

drop function if exists public.get_registration_pricing_preview(text, text, uuid, uuid);
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
  text,
  uuid
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
  p_coupon_code text default null,
  p_ticket_category_id uuid default null
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
  v_ticket_category_id uuid;
  v_ticket_category_capacity integer;
  v_category_reserved_count integer;
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

  select count(*)::integer into v_category_reserved_count
  from public.participants p
  where p.event_id = v_event_id
    and p.ticket_category_id = v_ticket_category_id
    and coalesce(p.registration_status, 'pending') <> 'cancelled'
    and p.reservation_status in ('pending', 'confirmed');

  if v_ticket_category_capacity is not null and v_category_reserved_count >= v_ticket_category_capacity then
    raise exception 'Capacidade da categoria de acesso atingida.';
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
  end if;

  if v_gender_key in ('feminino', 'female', 'f') then
    select round(rbp.female_price, 2) into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;
  elsif v_gender_key in ('masculino', 'male', 'm') then
    select round(rbp.male_price, 2) into v_base_amount
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

  if lower(coalesce(v_payment_method, '')) = 'courtesy' then
    v_payment_status := 'paid';
    v_payment_method := 'courtesy';
  end if;

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
    v_final_amount,
    v_ticket_category_id
  ) returning id into v_participant_id;

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
      'final_amount', v_final_amount,
      'ticket_category_id', v_ticket_category_id
    ),
    v_event_id
  );

  if v_payment_status = 'paid' then
    perform * from public.confirm_registration_payment(v_participant_id);
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

revoke all on function public.upsert_registration_batch_prices(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.create_registration_batch_with_prices(uuid, text, integer, numeric, numeric, integer, timestamptz, timestamptz, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.update_registration_batch_with_prices(uuid, uuid, text, integer, numeric, numeric, integer, timestamptz, timestamptz, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.get_registration_pricing_preview(text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_registration(text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.upsert_registration_batch_prices(uuid, uuid, jsonb) to anon, authenticated;
grant execute on function public.create_registration_batch_with_prices(uuid, text, integer, numeric, numeric, integer, timestamptz, timestamptz, boolean, jsonb) to anon, authenticated;
grant execute on function public.update_registration_batch_with_prices(uuid, uuid, text, integer, numeric, numeric, integer, timestamptz, timestamptz, boolean, jsonb) to anon, authenticated;
grant execute on function public.get_registration_pricing_preview(text, text, uuid, uuid) to anon, authenticated;
grant execute on function public.create_registration(text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid) to anon, authenticated;
