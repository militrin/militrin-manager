-- 026_event_scoped_inventory.sql
-- Estoque estritamente vinculado a event_id, com inicializacao idempotente por evento.

create unique index if not exists ux_shirt_inventory_event_type_size
  on public.shirt_inventory (event_id, shirt_type, shirt_size);

create index if not exists idx_inventory_movements_event_inventory_created_at
  on public.inventory_movements (event_id, inventory_id, created_at desc);

create or replace function public.initialize_event_inventory(
  p_event_id uuid,
  p_source_event_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_event_id uuid;
  v_inserted_count integer := 0;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio para inicializacao do estoque.';
  end if;

  select id
    into v_source_event_id
  from public.events
  where id = coalesce(p_source_event_id, (
    select id
    from public.events
    where is_active = true
      and id <> p_event_id
    order by updated_at desc, created_at desc
    limit 1
  ))
  limit 1;

  if v_source_event_id is null then
    with default_variants as (
      select *
      from (
        values
          ('Camiseta', 'PP'),
          ('Camiseta', 'P'),
          ('Camiseta', 'M'),
          ('Camiseta', 'G'),
          ('Camiseta', 'GG'),
          ('Camiseta', 'EG'),
          ('Camiseta', 'EXG'),
          ('Camiseta', 'EXGG'),
          ('Babylook', 'PP'),
          ('Babylook', 'P'),
          ('Babylook', 'M'),
          ('Babylook', 'G'),
          ('Babylook', 'GG'),
          ('Babylook', 'EG')
      ) as v(shirt_type, shirt_size)
    ), inserted as (
      insert into public.shirt_inventory (
        event_id,
        shirt_type,
        shirt_size,
        total_quantity,
        reserved_quantity,
        delivered_quantity
      )
      select
        p_event_id,
        dv.shirt_type,
        dv.shirt_size,
        0,
        0,
        0
      from default_variants dv
      where not exists (
        select 1
        from public.shirt_inventory existing
        where existing.event_id = p_event_id
          and existing.shirt_type = dv.shirt_type
          and existing.shirt_size = dv.shirt_size
      )
      returning 1
    )
    select count(*)::integer into v_inserted_count from inserted;

    return v_inserted_count;
  end if;

  with source_variants as (
    select distinct
      si.shirt_type,
      si.shirt_size
    from public.shirt_inventory si
    where si.event_id = v_source_event_id
  ), inserted as (
    insert into public.shirt_inventory (
      event_id,
      shirt_type,
      shirt_size,
      total_quantity,
      reserved_quantity,
      delivered_quantity
    )
    select
      p_event_id,
      sv.shirt_type,
      sv.shirt_size,
      0,
      0,
      0
    from source_variants sv
    where not exists (
      select 1
      from public.shirt_inventory existing
      where existing.event_id = p_event_id
        and existing.shirt_type = sv.shirt_type
        and existing.shirt_size = sv.shirt_size
    )
    returning 1
  )
  select count(*)::integer into v_inserted_count from inserted;

  return v_inserted_count;
end;
$$;

revoke all on function public.initialize_event_inventory(uuid, uuid) from public, anon, authenticated;
grant execute on function public.initialize_event_inventory(uuid, uuid) to authenticated;

do $$
begin
  if exists (
    select 1
    from public.shirt_inventory
    group by event_id, shirt_type, shirt_size
    having count(*) > 1
  ) then
    raise exception 'Backfill interrompido: existem linhas duplicadas em shirt_inventory para o mesmo evento/modelo/tamanho.';
  end if;
end
$$;

alter table public.shirt_inventory
  alter column event_id set not null;

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

  perform public.initialize_event_inventory(v_event_id, null);

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

create or replace function public.add_inventory_quantity(
  p_event_id uuid,
  p_inventory_id uuid,
  p_quantity integer,
  p_notes text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.shirt_inventory%rowtype;
  v_new_total integer;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantidade deve ser maior que zero.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada para o evento informado.';
  end if;

  update public.shirt_inventory
  set
    total_quantity = total_quantity + p_quantity,
    updated_at = now()
  where id = p_inventory_id
  returning total_quantity into v_new_total;

  insert into public.inventory_movements (
    event_id,
    inventory_id,
    movement_type,
    quantity,
    notes
  ) values (
    p_event_id,
    p_inventory_id,
    'purchase',
    p_quantity,
    nullif(trim(p_notes), '')
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'inventory_quantity_added',
    'shirt_inventory',
    p_inventory_id,
    jsonb_build_object(
      'movement_type', 'purchase',
      'quantity', p_quantity,
      'notes', nullif(trim(p_notes), ''),
      'previous_total', v_item.total_quantity,
      'new_total', v_new_total,
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size
    ),
    p_event_id
  );

  return true;
end;
$$;

create or replace function public.adjust_inventory_quantity(
  p_event_id uuid,
  p_inventory_id uuid,
  p_quantity_delta integer,
  p_notes text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.shirt_inventory%rowtype;
  v_new_total integer;
  v_min_total integer;
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  if p_quantity_delta is null or p_quantity_delta = 0 then
    raise exception 'Quantidade de ajuste deve ser diferente de zero.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada para o evento informado.';
  end if;

  v_new_total := v_item.total_quantity + p_quantity_delta;
  v_min_total := v_item.reserved_quantity + v_item.delivered_quantity;

  if v_new_total < v_min_total then
    raise exception 'Total nao pode ficar menor que reservadas + entregues.';
  end if;

  if v_new_total < 0 then
    raise exception 'Total nao pode ficar negativo.';
  end if;

  update public.shirt_inventory
  set
    total_quantity = v_new_total,
    updated_at = now()
  where id = p_inventory_id;

  insert into public.inventory_movements (
    event_id,
    inventory_id,
    movement_type,
    quantity,
    notes
  ) values (
    p_event_id,
    p_inventory_id,
    'adjustment',
    p_quantity_delta,
    nullif(trim(p_notes), '')
  );

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'inventory_quantity_adjusted',
    'shirt_inventory',
    p_inventory_id,
    jsonb_build_object(
      'movement_type', 'adjustment',
      'quantity', p_quantity_delta,
      'notes', nullif(trim(p_notes), ''),
      'previous_total', v_item.total_quantity,
      'new_total', v_new_total,
      'reserved_quantity', v_item.reserved_quantity,
      'delivered_quantity', v_item.delivered_quantity,
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size
    ),
    p_event_id
  );

  return true;
end;
$$;

create or replace function public.delete_inventory_item(
  p_event_id uuid,
  p_inventory_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.shirt_inventory%rowtype;
  v_actor text := coalesce(auth.role(), 'anon');
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if p_inventory_id is null then
    raise exception 'ID do item e obrigatorio.';
  end if;

  select * into v_item
  from public.shirt_inventory
  where id = p_inventory_id
    and event_id = p_event_id
  for update;

  if not found then
    raise exception 'Linha de estoque nao encontrada para o evento informado.';
  end if;

  delete from public.shirt_inventory
  where id = p_inventory_id;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'inventory_item_deleted',
    'shirt_inventory',
    p_inventory_id,
    p_event_id,
    jsonb_build_object(
      'shirt_type', v_item.shirt_type,
      'shirt_size', v_item.shirt_size,
      'total_quantity', v_item.total_quantity,
      'reserved_quantity', v_item.reserved_quantity,
      'delivered_quantity', v_item.delivered_quantity
    )
  );

  return true;
end;
$$;

revoke all on function public.create_event(text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.create_event(text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean) to anon, authenticated;

revoke all on function public.add_inventory_quantity(uuid, uuid, integer, text) from public, authenticated, anon;
revoke all on function public.adjust_inventory_quantity(uuid, uuid, integer, text) from public, authenticated, anon;
revoke all on function public.delete_inventory_item(uuid, uuid) from public, authenticated, anon;

grant execute on function public.add_inventory_quantity(uuid, uuid, integer, text) to authenticated;
grant execute on function public.adjust_inventory_quantity(uuid, uuid, integer, text) to authenticated;
grant execute on function public.delete_inventory_item(uuid, uuid) to authenticated;
