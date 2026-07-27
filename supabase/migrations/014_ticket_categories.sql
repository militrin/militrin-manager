-- 014_ticket_categories.sql
-- Categorias de acesso flexiveis por evento + precificacao por lote/categoria.

create table if not exists public.ticket_categories (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  name text not null,
  slug text not null,
  description text,
  capacity integer,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint ticket_categories_capacity_positive check (capacity is null or capacity > 0),
  constraint ticket_categories_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create unique index if not exists ux_ticket_categories_event_name
  on public.ticket_categories (event_id, lower(name));

create unique index if not exists ux_ticket_categories_event_slug
  on public.ticket_categories (event_id, slug);

create index if not exists idx_ticket_categories_event_active
  on public.ticket_categories (event_id, is_active, sort_order);

create or replace function public.normalize_ticket_category_slug()
returns trigger
language plpgsql
as $$
begin
  new.name := trim(new.name);
  new.slug := lower(regexp_replace(trim(new.slug), '[^a-z0-9]+', '-', 'g'));
  new.slug := regexp_replace(new.slug, '^-+|-+$', '', 'g');
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_ticket_categories_normalize on public.ticket_categories;
create trigger trg_ticket_categories_normalize
before insert or update on public.ticket_categories
for each row
execute function public.normalize_ticket_category_slug();

create table if not exists public.registration_batch_prices (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.registration_batches(id),
  ticket_category_id uuid not null references public.ticket_categories(id),
  male_price numeric(10,2) not null,
  female_price numeric(10,2) not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint registration_batch_prices_male_nonnegative check (male_price >= 0),
  constraint registration_batch_prices_female_nonnegative check (female_price >= 0)
);

create unique index if not exists ux_registration_batch_prices_batch_category
  on public.registration_batch_prices (batch_id, ticket_category_id);

create index if not exists idx_registration_batch_prices_batch
  on public.registration_batch_prices (batch_id);

create index if not exists idx_registration_batch_prices_category
  on public.registration_batch_prices (ticket_category_id);

create or replace function public.touch_registration_batch_prices_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_registration_batch_prices_updated_at on public.registration_batch_prices;
create trigger trg_touch_registration_batch_prices_updated_at
before update on public.registration_batch_prices
for each row
execute function public.touch_registration_batch_prices_updated_at();

create table if not exists public.ticket_category_benefits (
  id uuid primary key default gen_random_uuid(),
  ticket_category_id uuid not null references public.ticket_categories(id),
  name text not null,
  description text,
  sort_order integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_ticket_category_benefits_category
  on public.ticket_category_benefits (ticket_category_id, sort_order, created_at);

create or replace function public.touch_ticket_category_benefits_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_ticket_category_benefits_updated_at on public.ticket_category_benefits;
create trigger trg_touch_ticket_category_benefits_updated_at
before update on public.ticket_category_benefits
for each row
execute function public.touch_ticket_category_benefits_updated_at();

alter table public.participants
  add column if not exists ticket_category_id uuid references public.ticket_categories(id);

create index if not exists idx_participants_ticket_category_id
  on public.participants (ticket_category_id);

create index if not exists idx_participants_event_category_status
  on public.participants (event_id, ticket_category_id, reservation_status, registration_status);

-- Garante categoria Open Bar para o evento ativo e vincula participantes legados.
do $$
declare
  v_active_event_id uuid;
  v_open_bar_id uuid;
begin
  select id into v_active_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_active_event_id is not null then
    insert into public.ticket_categories (
      event_id,
      name,
      slug,
      description,
      capacity,
      is_active,
      sort_order
    )
    values (
      v_active_event_id,
      'Open Bar',
      'open-bar',
      'Categoria padrao para continuidade do evento atual.',
      null::integer,
      true,
      10
    )
    on conflict (event_id, slug)
    do update set
      name = excluded.name,
      description = coalesce(public.ticket_categories.description, excluded.description),
      is_active = true,
      updated_at = now()
    returning id into v_open_bar_id;

    if v_open_bar_id is null then
      select id into v_open_bar_id
      from public.ticket_categories
      where event_id = v_active_event_id
        and slug = 'open-bar'
      limit 1;
    end if;

    if v_open_bar_id is not null then
      update public.participants
      set ticket_category_id = v_open_bar_id,
          updated_at = now()
      where event_id = v_active_event_id
        and ticket_category_id is null;
    end if;
  end if;
end;
$$;

-- Cria Open Bar para eventos com lotes e replica preco legado por lote.
insert into public.ticket_categories (
  event_id,
  name,
  slug,
  description,
  capacity,
  is_active,
  sort_order
)
select distinct
  rb.event_id,
  'Open Bar',
  'open-bar',
  'Categoria padrao inicial para lotes existentes.',
  null::integer,
  true,
  10
from public.registration_batches rb
where rb.event_id is not null
on conflict (event_id, slug)
do nothing;

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
on conflict (batch_id, ticket_category_id)
do update set
  male_price = excluded.male_price,
  female_price = excluded.female_price,
  updated_at = now();

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
    tc.created_at,
    tc.updated_at
  from public.ticket_categories tc
  left join stats s
    on s.ticket_category_id = tc.id
  where tc.event_id = v_event_id
  order by tc.sort_order asc, tc.name asc;
end;
$$;

create or replace function public.create_ticket_category(
  p_event_id uuid,
  p_name text,
  p_slug text,
  p_description text default null,
  p_capacity integer default null::integer,
  p_is_active boolean default true,
  p_sort_order integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category_id uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_slug text := trim(coalesce(p_slug, ''));
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if v_name = '' then
    raise exception 'Nome da categoria obrigatorio.';
  end if;

  if v_slug = '' then
    v_slug := lower(regexp_replace(v_name, '[^a-z0-9]+', '-', 'g'));
  end if;

  if p_capacity is not null and p_capacity <= 0 then
    raise exception 'Capacidade deve ser maior que zero.';
  end if;

  insert into public.ticket_categories (
    event_id,
    name,
    slug,
    description,
    capacity,
    is_active,
    sort_order
  )
  values (
    p_event_id,
    v_name,
    v_slug,
    nullif(trim(coalesce(p_description, '')), ''),
    p_capacity,
    coalesce(p_is_active, true),
    coalesce(p_sort_order, 0)
  )
  returning id into v_category_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'ticket_category_created',
    'ticket_categories',
    v_category_id,
    jsonb_build_object(
      'name', v_name,
      'slug', v_slug,
      'capacity', p_capacity,
      'is_active', coalesce(p_is_active, true),
      'sort_order', coalesce(p_sort_order, 0)
    ),
    p_event_id
  );

  return v_category_id;
end;
$$;

create or replace function public.update_ticket_category(
  p_category_id uuid,
  p_event_id uuid,
  p_name text,
  p_slug text,
  p_description text default null,
  p_capacity integer default null::integer,
  p_is_active boolean default true,
  p_sort_order integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category public.ticket_categories%rowtype;
  v_name text := trim(coalesce(p_name, ''));
  v_slug text := trim(coalesce(p_slug, ''));
begin
  if p_category_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select * into v_category
  from public.ticket_categories
  where id = p_category_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Categoria nao encontrada para o evento.';
  end if;

  if v_name = '' then
    raise exception 'Nome da categoria obrigatorio.';
  end if;

  if v_slug = '' then
    v_slug := lower(regexp_replace(v_name, '[^a-z0-9]+', '-', 'g'));
  end if;

  if p_capacity is not null and p_capacity <= 0 then
    raise exception 'Capacidade deve ser maior que zero.';
  end if;

  update public.ticket_categories
  set
    name = v_name,
    slug = v_slug,
    description = nullif(trim(coalesce(p_description, '')), ''),
    capacity = p_capacity,
    is_active = coalesce(p_is_active, true),
    sort_order = coalesce(p_sort_order, 0),
    updated_at = now()
  where id = p_category_id
    and event_id = p_event_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'ticket_category_updated',
    'ticket_categories',
    p_category_id,
    jsonb_build_object(
      'name', v_name,
      'slug', v_slug,
      'capacity', p_capacity,
      'is_active', coalesce(p_is_active, true),
      'sort_order', coalesce(p_sort_order, 0)
    ),
    p_event_id
  );

  return true;
end;
$$;

create or replace function public.set_ticket_category_active(
  p_category_id uuid,
  p_event_id uuid,
  p_is_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_category_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  update public.ticket_categories
  set
    is_active = coalesce(p_is_active, true),
    updated_at = now()
  where id = p_category_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Categoria nao encontrada para o evento.';
  end if;

  return true;
end;
$$;

create or replace function public.delete_ticket_category(
  p_category_id uuid,
  p_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_used boolean;
begin
  if p_category_id is null or p_event_id is null then
    raise exception 'Parametros obrigatorios ausentes.';
  end if;

  select exists (
    select 1
    from public.participants p
    where p.ticket_category_id = p_category_id
      and p.event_id = p_event_id
  ) into v_used;

  if v_used then
    raise exception 'Nao e permitido apagar categoria ja utilizada por inscricoes.';
  end if;

  delete from public.ticket_category_benefits
  where ticket_category_id = p_category_id;

  delete from public.registration_batch_prices
  where ticket_category_id = p_category_id;

  delete from public.ticket_categories
  where id = p_category_id
    and event_id = p_event_id;

  if not found then
    raise exception 'Categoria nao encontrada para o evento.';
  end if;

  return true;
end;
$$;

create or replace function public.create_ticket_category_benefit(
  p_ticket_category_id uuid,
  p_name text,
  p_description text default null,
  p_sort_order integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_ticket_category_id is null then
    raise exception 'Categoria obrigatoria.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do beneficio obrigatorio.';
  end if;

  insert into public.ticket_category_benefits (
    ticket_category_id,
    name,
    description,
    sort_order
  ) values (
    p_ticket_category_id,
    trim(p_name),
    nullif(trim(coalesce(p_description, '')), ''),
    coalesce(p_sort_order, 0)
  ) returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.delete_ticket_category_benefit(
  p_benefit_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_benefit_id is null then
    raise exception 'Beneficio obrigatorio.';
  end if;

  delete from public.ticket_category_benefits
  where id = p_benefit_id;

  if not found then
    raise exception 'Beneficio nao encontrado.';
  end if;

  return true;
end;
$$;

drop function if exists public.get_registration_pricing_preview(text, text, uuid);
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

    if v_base is null then
      v_base := round(v_batch.female_price, 2);
    end if;
  elsif v_gender_key in ('masculino', 'male', 'm') then
    select round(rbp.male_price, 2) into v_base
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;

    if v_base is null then
      v_base := round(v_batch.male_price, 2);
    end if;
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

    if v_base_amount is null then
      v_base_amount := round(v_batch.female_price, 2);
    end if;
  elsif v_gender_key in ('masculino', 'male', 'm') then
    select round(rbp.male_price, 2) into v_base_amount
    from public.registration_batch_prices rbp
    where rbp.batch_id = v_batch.id
      and rbp.ticket_category_id = v_ticket_category_id
    limit 1;

    if v_base_amount is null then
      v_base_amount := round(v_batch.male_price, 2);
    end if;
  else
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
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

alter table public.ticket_categories enable row level security;
alter table public.registration_batch_prices enable row level security;
alter table public.ticket_category_benefits enable row level security;

drop policy if exists "ticket_categories_read_only" on public.ticket_categories;
create policy "ticket_categories_read_only"
on public.ticket_categories
for select
to anon, authenticated
using (true);

drop policy if exists "registration_batch_prices_read_only" on public.registration_batch_prices;
create policy "registration_batch_prices_read_only"
on public.registration_batch_prices
for select
to anon, authenticated
using (true);

drop policy if exists "ticket_category_benefits_read_only" on public.ticket_category_benefits;
create policy "ticket_category_benefits_read_only"
on public.ticket_category_benefits
for select
to anon, authenticated
using (true);

revoke insert, update, delete on table public.ticket_categories from anon, authenticated;
revoke insert, update, delete on table public.registration_batch_prices from anon, authenticated;
revoke insert, update, delete on table public.ticket_category_benefits from anon, authenticated;

grant select on table public.ticket_categories to anon, authenticated;
grant select on table public.registration_batch_prices to anon, authenticated;
grant select on table public.ticket_category_benefits to anon, authenticated;

revoke all on function public.get_event_ticket_categories(uuid) from public, anon, authenticated;
revoke all on function public.create_ticket_category(uuid, text, text, text, integer, boolean, integer) from public, anon, authenticated;
revoke all on function public.update_ticket_category(uuid, uuid, text, text, text, integer, boolean, integer) from public, anon, authenticated;
revoke all on function public.set_ticket_category_active(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.delete_ticket_category(uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_ticket_category_benefit(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.delete_ticket_category_benefit(uuid) from public, anon, authenticated;
revoke all on function public.get_registration_pricing_preview(text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_registration(text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.confirm_registration_payment(uuid) from public, anon, authenticated;

grant execute on function public.get_event_ticket_categories(uuid) to anon, authenticated;
grant execute on function public.create_ticket_category(uuid, text, text, text, integer, boolean, integer) to anon, authenticated;
grant execute on function public.update_ticket_category(uuid, uuid, text, text, text, integer, boolean, integer) to anon, authenticated;
grant execute on function public.set_ticket_category_active(uuid, uuid, boolean) to anon, authenticated;
grant execute on function public.delete_ticket_category(uuid, uuid) to anon, authenticated;
grant execute on function public.create_ticket_category_benefit(uuid, text, text, integer) to anon, authenticated;
grant execute on function public.delete_ticket_category_benefit(uuid) to anon, authenticated;
grant execute on function public.get_registration_pricing_preview(text, text, uuid, uuid) to anon, authenticated;
grant execute on function public.create_registration(text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid) to anon, authenticated;
grant execute on function public.confirm_registration_payment(uuid) to anon, authenticated;
