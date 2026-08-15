-- 015_events_and_kit_items.sql
-- Gestao de eventos multi-configuracao com kit flexivel por itens.

create extension if not exists pgcrypto;

create or replace function public.slugify_text(p_input text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    regexp_replace(lower(coalesce(trim(p_input), '')), '[^a-z0-9]+', '-', 'g'),
    '(^-|-$)',
    '',
    'g'
  );
$$;

alter table public.events
  add column if not exists slug text,
  add column if not exists description text,
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists registration_open_at timestamptz,
  add column if not exists registration_close_at timestamptz,
  add column if not exists location text,
  add column if not exists registration_enabled boolean not null default false,
  add column if not exists kit_enabled boolean not null default false;

update public.events
set
  registration_open_at = coalesce(registration_open_at, registration_open),
  registration_close_at = coalesce(registration_close_at, registration_close),
  slug = coalesce(nullif(trim(slug), ''), public.slugify_text(name || '-' || coalesce(year::text, extract(year from now())::text))),
  updated_at = now()
where
  registration_open_at is null
  or registration_close_at is null
  or slug is null
  or trim(slug) = '';

with duplicate_slug_events as (
  select
    id,
    row_number() over (
      partition by slug
      order by created_at asc, id asc
    ) as rn
  from public.events
  where slug is not null
)
update public.events e
set slug = public.slugify_text(e.name || '-' || e.id::text)
from duplicate_slug_events d
where e.id = d.id
  and d.rn > 1;

with active_events_ranked as (
  select
    id,
    row_number() over (order by updated_at desc, created_at desc, id asc) as rn
  from public.events
  where is_active = true
)
update public.events e
set is_active = false,
    updated_at = now()
from active_events_ranked r
where e.id = r.id
  and r.rn > 1;

create unique index if not exists ux_events_slug on public.events (slug);
create unique index if not exists ux_events_single_active on public.events ((1)) where is_active = true;

create or replace function public.normalize_events_before_write()
returns trigger
language plpgsql
as $$
begin
  new.name := trim(new.name);
  new.slug := public.slugify_text(coalesce(nullif(new.slug, ''), new.name || '-' || coalesce(new.year::text, extract(year from now())::text)));
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_events_normalize_before_write on public.events;
create trigger trg_events_normalize_before_write
before insert or update on public.events
for each row
execute function public.normalize_events_before_write();

create table if not exists public.event_kit_items (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id),
  name text not null,
  slug text not null,
  description text,
  item_type text not null check (item_type in ('shirt', 'cup', 'strap', 'cup_holder', 'wristband', 'badge', 'voucher', 'other')),
  quantity_per_participant integer not null default 1,
  requires_variant boolean not null default false,
  is_required boolean not null default true,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint event_kit_items_quantity_positive check (quantity_per_participant > 0)
);

create unique index if not exists ux_event_kit_items_event_slug
  on public.event_kit_items (event_id, slug);

create index if not exists idx_event_kit_items_event_active
  on public.event_kit_items (event_id, is_active, sort_order);

create table if not exists public.event_kit_item_variants (
  id uuid primary key default gen_random_uuid(),
  kit_item_id uuid not null references public.event_kit_items(id),
  name text not null,
  value text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

create index if not exists idx_event_kit_item_variants_item
  on public.event_kit_item_variants (kit_item_id, is_active, sort_order);

create table if not exists public.participant_kit_items (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id),
  event_id uuid not null references public.events(id),
  kit_item_id uuid not null references public.event_kit_items(id),
  variant_data jsonb,
  quantity integer not null default 1,
  status text not null default 'reserved' check (status in ('reserved', 'confirmed', 'delivered', 'cancelled')),
  delivered_at timestamptz,
  created_at timestamptz default now(),
  constraint participant_kit_items_quantity_positive check (quantity > 0)
);

create unique index if not exists ux_participant_kit_items_participant_item
  on public.participant_kit_items (participant_id, kit_item_id);

create index if not exists idx_participant_kit_items_participant
  on public.participant_kit_items (participant_id, status);

create index if not exists idx_participant_kit_items_event
  on public.participant_kit_items (event_id, status);

create or replace function public.touch_event_kit_items_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.name := trim(new.name);
  new.slug := public.slugify_text(coalesce(nullif(new.slug, ''), new.name));
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_event_kit_items on public.event_kit_items;
create trigger trg_touch_event_kit_items
before insert or update on public.event_kit_items
for each row
execute function public.touch_event_kit_items_updated_at();

create or replace function public.get_events_overview()
returns table (
  id uuid,
  name text,
  slug text,
  year integer,
  description text,
  starts_at timestamptz,
  ends_at timestamptz,
  registration_open_at timestamptz,
  registration_close_at timestamptz,
  location text,
  registration_enabled boolean,
  kit_enabled boolean,
  is_active boolean,
  participants_count integer,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    e.id,
    e.name,
    e.slug,
    e.year,
    e.description,
    e.starts_at,
    e.ends_at,
    e.registration_open_at,
    e.registration_close_at,
    e.location,
    e.registration_enabled,
    e.kit_enabled,
    e.is_active,
    count(p.id)::integer as participants_count,
    e.created_at,
    e.updated_at
  from public.events e
  left join public.participants p
    on p.event_id = e.id
   and coalesce(p.registration_status, 'pending') <> 'cancelled'
  group by e.id
  order by e.year desc nulls last, e.created_at desc;
$$;

create or replace function public.create_event(
  p_name text,
  p_slug text,
  p_year integer default null,
  p_description text default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_registration_open_at timestamptz default null,
  p_registration_close_at timestamptz default null,
  p_location text default null,
  p_is_active boolean default false,
  p_registration_enabled boolean default false,
  p_kit_enabled boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_slug text;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do evento obrigatorio.';
  end if;

  v_slug := public.slugify_text(coalesce(nullif(trim(p_slug), ''), p_name || '-' || coalesce(p_year::text, extract(year from now())::text)));
  if v_slug = '' then
    raise exception 'Slug do evento invalido.';
  end if;

  if coalesce(p_is_active, false) then
    update public.events
    set is_active = false,
        updated_at = now()
    where is_active = true;
  end if;

  insert into public.events (
    name,
    slug,
    year,
    description,
    starts_at,
    ends_at,
    registration_open_at,
    registration_close_at,
    location,
    is_active,
    registration_enabled,
    kit_enabled
  ) values (
    trim(p_name),
    v_slug,
    p_year,
    nullif(trim(coalesce(p_description, '')), ''),
    p_starts_at,
    p_ends_at,
    p_registration_open_at,
    p_registration_close_at,
    nullif(trim(coalesce(p_location, '')), ''),
    coalesce(p_is_active, false),
    coalesce(p_registration_enabled, false),
    coalesce(p_kit_enabled, false)
  ) returning id into v_event_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'event_created',
    'events',
    v_event_id,
    v_event_id,
    jsonb_build_object(
      'name', trim(p_name),
      'slug', v_slug,
      'year', p_year,
      'is_active', coalesce(p_is_active, false),
      'registration_enabled', coalesce(p_registration_enabled, false),
      'kit_enabled', coalesce(p_kit_enabled, false)
    )
  );

  return v_event_id;
end;
$$;

create or replace function public.update_event(
  p_event_id uuid,
  p_name text,
  p_slug text,
  p_year integer default null,
  p_description text default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_registration_open_at timestamptz default null,
  p_registration_close_at timestamptz default null,
  p_location text default null,
  p_is_active boolean default false,
  p_registration_enabled boolean default false,
  p_kit_enabled boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_slug text;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do evento obrigatorio.';
  end if;

  v_slug := public.slugify_text(coalesce(nullif(trim(p_slug), ''), p_name || '-' || coalesce(p_year::text, extract(year from now())::text)));

  if coalesce(p_is_active, false) then
    update public.events
    set is_active = false,
        updated_at = now()
    where is_active = true
      and id <> p_event_id;
  end if;

  update public.events
  set
    name = trim(p_name),
    slug = v_slug,
    year = p_year,
    description = nullif(trim(coalesce(p_description, '')), ''),
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    registration_open_at = p_registration_open_at,
    registration_close_at = p_registration_close_at,
    location = nullif(trim(coalesce(p_location, '')), ''),
    is_active = coalesce(p_is_active, false),
    registration_enabled = coalesce(p_registration_enabled, false),
    kit_enabled = coalesce(p_kit_enabled, false),
    updated_at = now()
  where id = p_event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'event_updated',
    'events',
    p_event_id,
    p_event_id,
    jsonb_build_object(
      'name', trim(p_name),
      'slug', v_slug,
      'year', p_year,
      'is_active', coalesce(p_is_active, false),
      'registration_enabled', coalesce(p_registration_enabled, false),
      'kit_enabled', coalesce(p_kit_enabled, false)
    )
  );

  return true;
end;
$$;

create or replace function public.set_event_active(
  p_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  update public.events
  set is_active = false,
      updated_at = now()
  where is_active = true
    and id <> p_event_id;

  update public.events
  set is_active = true,
      updated_at = now()
  where id = p_event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'event_activated',
    'events',
    p_event_id,
    p_event_id,
    '{}'::jsonb
  );

  return true;
end;
$$;

create or replace function public.set_event_registration_enabled(
  p_event_id uuid,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  update public.events
  set registration_enabled = coalesce(p_enabled, false),
      updated_at = now()
  where id = p_event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'event_registration_toggled',
    'events',
    p_event_id,
    p_event_id,
    jsonb_build_object('registration_enabled', coalesce(p_enabled, false))
  );

  return true;
end;
$$;

create or replace function public.archive_event(
  p_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  update public.events
  set is_active = false,
      registration_enabled = false,
      updated_at = now()
  where id = p_event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'event_archived',
    'events',
    p_event_id,
    p_event_id,
    '{}'::jsonb
  );

  return true;
end;
$$;

create or replace function public.get_event_kit_items(
  p_event_id uuid
)
returns table (
  id uuid,
  event_id uuid,
  name text,
  slug text,
  description text,
  item_type text,
  quantity_per_participant integer,
  requires_variant boolean,
  is_required boolean,
  is_active boolean,
  sort_order integer,
  created_at timestamptz,
  updated_at timestamptz,
  variants jsonb
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    i.id,
    i.event_id,
    i.name,
    i.slug,
    i.description,
    i.item_type,
    i.quantity_per_participant,
    i.requires_variant,
    i.is_required,
    i.is_active,
    i.sort_order,
    i.created_at,
    i.updated_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', v.id,
            'name', v.name,
            'value', v.value,
            'sort_order', v.sort_order,
            'is_active', v.is_active,
            'created_at', v.created_at
          )
          order by v.sort_order asc, v.created_at asc
        )
        from public.event_kit_item_variants v
        where v.kit_item_id = i.id
      ),
      '[]'::jsonb
    ) as variants
  from public.event_kit_items i
  where i.event_id = p_event_id
  order by i.sort_order asc, i.created_at asc;
$$;

drop function if exists public.upsert_event_kit_item(uuid, uuid, text, text, text, text, integer, boolean, boolean, boolean, integer);
create or replace function public.upsert_event_kit_item(
  p_id uuid default null,
  p_event_id uuid default null,
  p_name text default null,
  p_slug text default null,
  p_description text default null,
  p_item_type text default 'other',
  p_quantity_per_participant integer default 1,
  p_requires_variant boolean default false,
  p_is_required boolean default true,
  p_is_active boolean default true,
  p_sort_order integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := p_id;
  v_slug text;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do item obrigatorio.';
  end if;

  if p_item_type not in ('shirt', 'cup', 'strap', 'cup_holder', 'wristband', 'badge', 'voucher', 'other') then
    raise exception 'Tipo de item invalido.';
  end if;

  if coalesce(p_quantity_per_participant, 0) <= 0 then
    raise exception 'Quantidade por participante deve ser maior que zero.';
  end if;

  v_slug := public.slugify_text(coalesce(nullif(trim(p_slug), ''), p_name));

  if v_id is null then
    insert into public.event_kit_items (
      event_id,
      name,
      slug,
      description,
      item_type,
      quantity_per_participant,
      requires_variant,
      is_required,
      is_active,
      sort_order
    ) values (
      p_event_id,
      trim(p_name),
      v_slug,
      nullif(trim(coalesce(p_description, '')), ''),
      p_item_type,
      p_quantity_per_participant,
      coalesce(p_requires_variant, false),
      coalesce(p_is_required, true),
      coalesce(p_is_active, true),
      coalesce(p_sort_order, 0)
    ) returning id into v_id;
  else
    update public.event_kit_items
    set
      name = trim(p_name),
      slug = v_slug,
      description = nullif(trim(coalesce(p_description, '')), ''),
      item_type = p_item_type,
      quantity_per_participant = p_quantity_per_participant,
      requires_variant = coalesce(p_requires_variant, false),
      is_required = coalesce(p_is_required, true),
      is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0),
      updated_at = now()
    where id = v_id
      and event_id = p_event_id;

    if not found then
      raise exception 'Item de kit nao encontrado para o evento.';
    end if;
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    case when p_id is null then 'event_kit_item_created' else 'event_kit_item_updated' end,
    'event_kit_items',
    v_id,
    p_event_id,
    jsonb_build_object(
      'name', trim(p_name),
      'slug', v_slug,
      'item_type', p_item_type,
      'quantity_per_participant', p_quantity_per_participant,
      'requires_variant', coalesce(p_requires_variant, false),
      'is_required', coalesce(p_is_required, true),
      'is_active', coalesce(p_is_active, true),
      'sort_order', coalesce(p_sort_order, 0)
    )
  );

  return v_id;
end;
$$;

create or replace function public.delete_event_kit_item(
  p_event_id uuid,
  p_kit_item_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_in_use boolean;
begin
  if p_event_id is null or p_kit_item_id is null then
    raise exception 'Evento e item obrigatorios.';
  end if;

  select exists (
    select 1
    from public.participant_kit_items pki
    where pki.kit_item_id = p_kit_item_id
  ) into v_in_use;

  if v_in_use then
    raise exception 'Nao e permitido excluir item ja vinculado a inscricoes/entregas.';
  end if;

  delete from public.event_kit_item_variants where kit_item_id = p_kit_item_id;
  delete from public.event_kit_items where id = p_kit_item_id and event_id = p_event_id;

  if not found then
    raise exception 'Item nao encontrado.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'event_kit_item_deleted',
    'event_kit_items',
    p_kit_item_id,
    p_event_id,
    '{}'::jsonb
  );

  return true;
end;
$$;

drop function if exists public.upsert_event_kit_item_variant(uuid, uuid, text, text, integer, boolean);
create or replace function public.upsert_event_kit_item_variant(
  p_id uuid default null,
  p_kit_item_id uuid default null,
  p_name text default null,
  p_value text default null,
  p_sort_order integer default 0,
  p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := p_id;
begin
  if p_kit_item_id is null then
    raise exception 'Item de kit obrigatorio.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome da variacao obrigatorio.';
  end if;

  if coalesce(trim(p_value), '') = '' then
    raise exception 'Valor da variacao obrigatorio.';
  end if;

  if v_id is null then
    insert into public.event_kit_item_variants (
      kit_item_id,
      name,
      value,
      sort_order,
      is_active
    ) values (
      p_kit_item_id,
      trim(p_name),
      trim(p_value),
      coalesce(p_sort_order, 0),
      coalesce(p_is_active, true)
    ) returning id into v_id;
  else
    update public.event_kit_item_variants
    set
      name = trim(p_name),
      value = trim(p_value),
      sort_order = coalesce(p_sort_order, 0),
      is_active = coalesce(p_is_active, true)
    where id = v_id
      and kit_item_id = p_kit_item_id;

    if not found then
      raise exception 'Variacao nao encontrada.';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.delete_event_kit_item_variant(
  p_variant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_variant_id is null then
    raise exception 'Variacao obrigatoria.';
  end if;

  delete from public.event_kit_item_variants
  where id = p_variant_id;

  if not found then
    raise exception 'Variacao nao encontrada.';
  end if;

  return true;
end;
$$;

create or replace function public.duplicate_event_configuration(
  p_source_event_id uuid,
  p_target_name text,
  p_target_slug text,
  p_target_year integer default null,
  p_copy_categories boolean default true,
  p_copy_kit_items boolean default true,
  p_copy_benefits boolean default true,
  p_copy_batches boolean default true,
  p_copy_batch_prices boolean default true,
  p_copy_inventory_structure boolean default true,
  p_copy_coupons boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_event_id uuid;
  v_item record;
  v_new_item_id uuid;
  v_new_batch_id uuid;
  v_batch record;
  v_open_bar_id uuid;
  v_target_category_id uuid;
begin
  if p_source_event_id is null then
    raise exception 'Evento de origem obrigatorio.';
  end if;

  v_target_event_id := public.create_event(
    p_target_name,
    p_target_slug,
    p_target_year,
    null,
    null,
    null,
    null,
    null,
    null,
    false,
    false,
    true
  );

  if p_copy_categories then
    insert into public.ticket_categories (
      event_id,
      name,
      slug,
      description,
      capacity,
      is_active,
      sort_order
    )
    select
      v_target_event_id,
      tc.name,
      tc.slug,
      tc.description,
      tc.capacity,
      tc.is_active,
      tc.sort_order
    from public.ticket_categories tc
    where tc.event_id = p_source_event_id
    on conflict (event_id, slug) do nothing;

    if p_copy_benefits then
      insert into public.ticket_category_benefits (
        ticket_category_id,
        name,
        description,
        sort_order
      )
      select
        tc_target.id,
        b.name,
        b.description,
        b.sort_order
      from public.ticket_category_benefits b
      join public.ticket_categories tc_source
        on tc_source.id = b.ticket_category_id
      join public.ticket_categories tc_target
        on tc_target.event_id = v_target_event_id
       and tc_target.slug = tc_source.slug
      where tc_source.event_id = p_source_event_id;
    end if;
  end if;

  if p_copy_kit_items then
    for v_item in
      select *
      from public.event_kit_items
      where event_id = p_source_event_id
      order by sort_order asc, created_at asc
    loop
      v_new_item_id := public.upsert_event_kit_item(
        null,
        v_target_event_id,
        v_item.name,
        v_item.slug,
        v_item.description,
        v_item.item_type,
        v_item.quantity_per_participant,
        v_item.requires_variant,
        v_item.is_required,
        v_item.is_active,
        v_item.sort_order
      );

      insert into public.event_kit_item_variants (
        kit_item_id,
        name,
        value,
        sort_order,
        is_active
      )
      select
        v_new_item_id,
        v.name,
        v.value,
        v.sort_order,
        v.is_active
      from public.event_kit_item_variants v
      where v.kit_item_id = v_item.id;
    end loop;
  end if;

  if p_copy_batches then
    for v_batch in
      select *
      from public.registration_batches
      where event_id = p_source_event_id
      order by sequence_number asc
    loop
      v_new_batch_id := public.create_registration_batch(
        v_target_event_id,
        v_batch.name,
        v_batch.sequence_number,
        v_batch.male_price,
        v_batch.female_price,
        v_batch.max_confirmed_registrations,
        v_batch.starts_at,
        v_batch.ends_at,
        false
      );

      if p_copy_batch_prices then
        insert into public.registration_batch_prices (
          batch_id,
          ticket_category_id,
          male_price,
          female_price
        )
        select
          v_new_batch_id,
          tc_target.id,
          rbp.male_price,
          rbp.female_price
        from public.registration_batch_prices rbp
        join public.ticket_categories tc_source
          on tc_source.id = rbp.ticket_category_id
        join public.ticket_categories tc_target
          on tc_target.event_id = v_target_event_id
         and tc_target.slug = tc_source.slug
        where rbp.batch_id = v_batch.id
        on conflict (batch_id, ticket_category_id)
        do update set
          male_price = excluded.male_price,
          female_price = excluded.female_price,
          updated_at = now();
      end if;
    end loop;
  end if;

  if p_copy_inventory_structure then
    perform public.initialize_event_inventory(v_target_event_id, p_source_event_id);
  end if;

  if p_copy_coupons then
    insert into public.coupons (
      event_id,
      code,
      description,
      coupon_type,
      discount_percent,
      max_uses,
      used_count,
      starts_at,
      ends_at,
      is_active
    )
    select
      v_target_event_id,
      c.code,
      c.description,
      c.coupon_type,
      c.discount_percent,
      c.max_uses,
      0,
      c.starts_at,
      c.ends_at,
      false
    from public.coupons c
    where c.event_id = p_source_event_id
    on conflict (event_id, code)
    do nothing;
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'event_configuration_duplicated',
    'events',
    v_target_event_id,
    v_target_event_id,
    jsonb_build_object(
      'source_event_id', p_source_event_id,
      'copy_categories', p_copy_categories,
      'copy_kit_items', p_copy_kit_items,
      'copy_benefits', p_copy_benefits,
      'copy_batches', p_copy_batches,
      'copy_batch_prices', p_copy_batch_prices,
      'copy_inventory_structure', p_copy_inventory_structure,
      'copy_coupons', p_copy_coupons
    )
  );

  return v_target_event_id;
end;
$$;

create or replace function public.get_participant_kit_items(
  p_participant_id uuid
)
returns table (
  participant_id uuid,
  event_id uuid,
  event_name text,
  kit_item_id uuid,
  item_name text,
  item_type text,
  quantity integer,
  status text,
  delivered_at timestamptz,
  variant_data jsonb
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    pki.participant_id,
    pki.event_id,
    e.name as event_name,
    pki.kit_item_id,
    eki.name as item_name,
    eki.item_type,
    pki.quantity,
    pki.status,
    pki.delivered_at,
    pki.variant_data
  from public.participant_kit_items pki
  join public.event_kit_items eki on eki.id = pki.kit_item_id
  join public.events e on e.id = pki.event_id
  where pki.participant_id = p_participant_id
  order by eki.sort_order asc, eki.created_at asc;
$$;

create or replace function public.deliver_participant_kit_item(
  p_participant_id uuid,
  p_kit_item_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.participant_kit_items%rowtype;
  v_event_id uuid;
  v_participant public.participants%rowtype;
  v_kit_item public.event_kit_items%rowtype;
  v_inventory public.shirt_inventory%rowtype;
begin
  if p_participant_id is null or p_kit_item_id is null then
    raise exception 'Participante e item sao obrigatorios.';
  end if;

  select * into v_item
  from public.participant_kit_items
  where participant_id = p_participant_id
    and kit_item_id = p_kit_item_id
  for update;

  if not found then
    raise exception 'Item do participante nao encontrado.';
  end if;

  if v_item.status = 'delivered' then
    raise exception 'Item ja foi entregue anteriormente.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select * into v_kit_item
  from public.event_kit_items
  where id = p_kit_item_id;

  if not found then
    raise exception 'Configuracao de item nao encontrada.';
  end if;

  if v_kit_item.item_type = 'shirt' then
    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para a camiseta do participante.';
    end if;

    if v_inventory.reserved_quantity < v_item.quantity then
      raise exception 'Reserva de camiseta insuficiente para entrega.';
    end if;

    update public.shirt_inventory
    set reserved_quantity = reserved_quantity - v_item.quantity,
        delivered_quantity = delivered_quantity + v_item.quantity,
        updated_at = now()
    where id = v_inventory.id;
  end if;

  update public.participant_kit_items
  set
    status = 'delivered',
    delivered_at = now()
  where id = v_item.id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'participant_kit_item_delivered',
    'participant_kit_items',
    v_item.id,
    v_item.event_id,
    jsonb_build_object(
      'participant_id', p_participant_id,
      'kit_item_id', p_kit_item_id,
      'item_type', v_kit_item.item_type,
      'quantity', v_item.quantity
    )
  );

  return true;
end;
$$;

create or replace function public.deliver_participant_full_kit(
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  for v_row in
    select pki.kit_item_id
    from public.participant_kit_items pki
    where pki.participant_id = p_participant_id
      and pki.status <> 'delivered'
  loop
    perform public.deliver_participant_kit_item(p_participant_id, v_row.kit_item_id);
  end loop;

  return true;
end;
$$;

create or replace function public.checkin_participant_entry(
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
begin
  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'participant_checkin_entry',
    'participants',
    p_participant_id,
    v_participant.event_id,
    '{}'::jsonb
  );

  return true;
end;
$$;

create or replace function public.deliver_kit(p_participant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.deliver_participant_full_kit(p_participant_id);
end;
$$;

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
  v_event public.events%rowtype;
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
  v_has_shirt_item boolean := false;
  v_shirt_type text;
  v_shirt_size text;
  v_kit_item record;
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

  select * into v_event
  from public.events
  where id = v_event_id;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.registration_enabled, false) then
    raise exception 'Inscricoes fechadas para este evento.';
  end if;

  select exists (
    select 1
    from public.event_kit_items eki
    where eki.event_id = v_event_id
      and eki.item_type = 'shirt'
      and eki.is_active = true
  ) into v_has_shirt_item;

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

  v_shirt_type := coalesce(nullif(trim(p_shirt_type), ''), 'Sem camiseta');
  v_shirt_size := coalesce(nullif(trim(p_shirt_size), ''), 'N/A');

  if v_has_shirt_item then
    if coalesce(trim(p_shirt_type), '') = '' or coalesce(trim(p_shirt_size), '') = '' then
      raise exception 'Camiseta obrigatoria para este evento.';
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

  if v_has_shirt_item then
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
  end if;

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
    v_shirt_type,
    v_shirt_size,
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

  if coalesce(v_event.kit_enabled, false) then
    for v_kit_item in
      select *
      from public.event_kit_items
      where event_id = v_event_id
        and is_active = true
      order by sort_order asc, created_at asc
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
          when v_kit_item.item_type = 'shirt' then jsonb_build_object('shirt_type', v_shirt_type, 'shirt_size', v_shirt_size)
          else null
        end,
        v_kit_item.quantity_per_participant,
        case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end
      )
      on conflict (participant_id, kit_item_id)
      do update set
        quantity = excluded.quantity,
        status = excluded.status,
        variant_data = excluded.variant_data;
    end loop;
  end if;

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
      'shirt_type', v_shirt_type,
      'shirt_size', v_shirt_size,
      'payment_status', v_payment_status,
      'reservation_status', v_reservation_status,
      'reservation_expires_at', v_reservation_expires_at,
      'batch_id', v_batch.id,
      'batch_name', v_batch.name,
      'sequence_number', v_batch.sequence_number,
      'base_amount', v_base_amount,
      'discount_amount', v_discount_amount,
      'final_amount', v_final_amount,
      'ticket_category_id', v_ticket_category_id,
      'kit_enabled', coalesce(v_event.kit_enabled, false)
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
    v_shirt_type,
    v_shirt_size;
end;
$$;

-- Backfill: preserva evento atual e configura itens base do Militrin 2026 sem duplicar.
update public.events
set
  kit_enabled = true,
  registration_enabled = coalesce(registration_enabled, true),
  updated_at = now()
where lower(name) = 'militrin 2026';

insert into public.event_kit_items (
  event_id,
  name,
  slug,
  description,
  item_type,
  quantity_per_participant,
  requires_variant,
  is_required,
  is_active,
  sort_order
)
select
  e.id,
  x.name,
  x.slug,
  x.description,
  x.item_type,
  x.quantity_per_participant,
  x.requires_variant,
  x.is_required,
  true,
  x.sort_order
from public.events e
cross join (
  values
    ('Camiseta', 'camiseta', 'Item de camiseta do kit.', 'shirt', 1, true, true, 10),
    ('Copo', 'copo', 'Copo oficial do evento.', 'cup', 1, false, true, 20),
    ('Tirante', 'tirante', 'Tirante oficial do evento.', 'strap', 1, false, true, 30),
    ('Porta-copo', 'porta-copo', 'Porta-copo oficial do evento.', 'cup_holder', 1, false, true, 40)
) as x(name, slug, description, item_type, quantity_per_participant, requires_variant, is_required, sort_order)
where lower(e.name) = 'militrin 2026'
on conflict (event_id, slug)
do update set
  name = excluded.name,
  description = excluded.description,
  item_type = excluded.item_type,
  quantity_per_participant = excluded.quantity_per_participant,
  requires_variant = excluded.requires_variant,
  is_required = excluded.is_required,
  is_active = true,
  sort_order = excluded.sort_order,
  updated_at = now();

-- Participantes legados: associa item de camiseta quando aplicavel, sem apagar dados.
insert into public.participant_kit_items (
  participant_id,
  event_id,
  kit_item_id,
  variant_data,
  quantity,
  status
)
select
  part.id,
  part.event_id,
  eki.id,
  jsonb_build_object('shirt_type', part.shirt_type, 'shirt_size', part.shirt_size),
  1,
  case when coalesce(pay.payment_status, 'pending') = 'paid' then 'confirmed' else 'reserved' end
from public.participants part
left join lateral (
  select payment_status
  from public.payments
  where participant_id = part.id
  order by created_at desc
  limit 1
) pay on true
join public.event_kit_items eki
  on eki.event_id = part.event_id
 and eki.item_type = 'shirt'
 and eki.is_active = true
where part.event_id is not null
  and coalesce(nullif(trim(coalesce(part.shirt_type, '')), ''), '') <> ''
  and coalesce(nullif(trim(coalesce(part.shirt_size, '')), ''), '') <> ''
on conflict (participant_id, kit_item_id)
do nothing;

alter table public.event_kit_items enable row level security;
alter table public.event_kit_item_variants enable row level security;
alter table public.participant_kit_items enable row level security;

drop policy if exists "event_kit_items_read_only" on public.event_kit_items;
create policy "event_kit_items_read_only"
on public.event_kit_items
for select
to anon, authenticated
using (true);

drop policy if exists "event_kit_item_variants_read_only" on public.event_kit_item_variants;
create policy "event_kit_item_variants_read_only"
on public.event_kit_item_variants
for select
to anon, authenticated
using (true);

drop policy if exists "participant_kit_items_read_only" on public.participant_kit_items;
create policy "participant_kit_items_read_only"
on public.participant_kit_items
for select
to anon, authenticated
using (true);

revoke insert, update, delete on table public.event_kit_items from anon, authenticated;
revoke insert, update, delete on table public.event_kit_item_variants from anon, authenticated;
revoke insert, update, delete on table public.participant_kit_items from anon, authenticated;

grant select on table public.event_kit_items to anon, authenticated;
grant select on table public.event_kit_item_variants to anon, authenticated;
grant select on table public.participant_kit_items to anon, authenticated;

revoke all on function public.get_events_overview() from public, anon, authenticated;
revoke all on function public.create_event(text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.update_event(uuid, text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.set_event_active(uuid) from public, anon, authenticated;
revoke all on function public.set_event_registration_enabled(uuid, boolean) from public, anon, authenticated;
revoke all on function public.archive_event(uuid) from public, anon, authenticated;
revoke all on function public.get_event_kit_items(uuid) from public, anon, authenticated;
revoke all on function public.upsert_event_kit_item(uuid, uuid, text, text, text, text, integer, boolean, boolean, boolean, integer) from public, anon, authenticated;
revoke all on function public.delete_event_kit_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.upsert_event_kit_item_variant(uuid, uuid, text, text, integer, boolean) from public, anon, authenticated;
revoke all on function public.delete_event_kit_item_variant(uuid) from public, anon, authenticated;
revoke all on function public.duplicate_event_configuration(uuid, text, text, integer, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.get_participant_kit_items(uuid) from public, anon, authenticated;
revoke all on function public.deliver_participant_kit_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.deliver_participant_full_kit(uuid) from public, anon, authenticated;
revoke all on function public.checkin_participant_entry(uuid) from public, anon, authenticated;
revoke all on function public.deliver_kit(uuid) from public, anon, authenticated;
revoke all on function public.create_registration(text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.get_events_overview() to anon, authenticated;
grant execute on function public.create_event(text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean) to anon, authenticated;
grant execute on function public.update_event(uuid, text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean) to anon, authenticated;
grant execute on function public.set_event_active(uuid) to anon, authenticated;
grant execute on function public.set_event_registration_enabled(uuid, boolean) to anon, authenticated;
grant execute on function public.archive_event(uuid) to anon, authenticated;
grant execute on function public.get_event_kit_items(uuid) to anon, authenticated;
grant execute on function public.upsert_event_kit_item(uuid, uuid, text, text, text, text, integer, boolean, boolean, boolean, integer) to anon, authenticated;
grant execute on function public.delete_event_kit_item(uuid, uuid) to anon, authenticated;
grant execute on function public.upsert_event_kit_item_variant(uuid, uuid, text, text, integer, boolean) to anon, authenticated;
grant execute on function public.delete_event_kit_item_variant(uuid) to anon, authenticated;
grant execute on function public.duplicate_event_configuration(uuid, text, text, integer, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to anon, authenticated;
grant execute on function public.get_participant_kit_items(uuid) to anon, authenticated;
grant execute on function public.deliver_participant_kit_item(uuid, uuid) to anon, authenticated;
grant execute on function public.deliver_participant_full_kit(uuid) to anon, authenticated;
grant execute on function public.checkin_participant_entry(uuid) to anon, authenticated;
grant execute on function public.deliver_kit(uuid) to anon, authenticated;
grant execute on function public.create_registration(text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid) to anon, authenticated;
