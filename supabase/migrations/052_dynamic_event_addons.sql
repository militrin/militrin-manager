-- 052_dynamic_event_addons.sql
-- Replace fixed add-ons with dynamic add-on options configurable by admin.

begin;

create table if not exists public.event_addons_model (
  event_id uuid primary key references public.events(id) on delete cascade,
  apply_to_all_batches boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.event_addon_options (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_event_addon_options_event
  on public.event_addon_options (event_id, is_active, sort_order, created_at);

create unique index if not exists ux_event_addon_options_event_name
  on public.event_addon_options (event_id, lower(name));

create table if not exists public.event_batch_addon_options (
  event_id uuid not null references public.events(id) on delete cascade,
  batch_id uuid not null references public.registration_batches(id) on delete cascade,
  option_id uuid not null references public.event_addon_options(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (batch_id, option_id)
);

create index if not exists idx_event_batch_addon_options_event
  on public.event_batch_addon_options (event_id, batch_id, option_id);

create or replace function public.upsert_event_addons_model(
  p_event_id uuid,
  p_apply_to_all_batches boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  insert into public.event_addons_model (event_id, apply_to_all_batches)
  values (p_event_id, coalesce(p_apply_to_all_batches, true))
  on conflict (event_id)
  do update set
    apply_to_all_batches = excluded.apply_to_all_batches,
    updated_at = now();
end;
$$;

create or replace function public.upsert_event_addon_option(
  p_event_id uuid,
  p_name text,
  p_description text,
  p_sort_order integer,
  p_is_active boolean,
  p_id uuid default null
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
    raise exception 'Nome do adicional obrigatorio.';
  end if;

  if p_id is null then
    insert into public.event_addon_options (
      event_id,
      name,
      description,
      sort_order,
      is_active
    ) values (
      p_event_id,
      trim(p_name),
      nullif(trim(coalesce(p_description, '')), ''),
      coalesce(p_sort_order, 0),
      coalesce(p_is_active, true)
    )
    returning id into v_id;
  else
    update public.event_addon_options
       set name = trim(p_name),
           description = nullif(trim(coalesce(p_description, '')), ''),
           sort_order = coalesce(p_sort_order, 0),
           is_active = coalesce(p_is_active, true),
           updated_at = now()
     where id = p_id
       and event_id = p_event_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Adicional nao encontrado para este evento.';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.delete_event_addon_option(
  p_event_id uuid,
  p_option_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event_id is null or p_option_id is null then
    raise exception 'Evento e adicional obrigatorios.';
  end if;

  delete from public.event_addon_options
  where id = p_option_id
    and event_id = p_event_id;
end;
$$;

create or replace function public.upsert_event_batch_addon_option(
  p_event_id uuid,
  p_batch_id uuid,
  p_option_id uuid,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event_id is null or p_batch_id is null or p_option_id is null then
    raise exception 'Evento, lote e adicional obrigatorios.';
  end if;

  if not exists (
    select 1
    from public.registration_batches b
    where b.id = p_batch_id
      and b.event_id = p_event_id
  ) then
    raise exception 'Lote nao pertence ao evento informado.';
  end if;

  if not exists (
    select 1
    from public.event_addon_options o
    where o.id = p_option_id
      and o.event_id = p_event_id
  ) then
    raise exception 'Adicional nao pertence ao evento informado.';
  end if;

  insert into public.event_batch_addon_options (
    event_id,
    batch_id,
    option_id,
    enabled
  ) values (
    p_event_id,
    p_batch_id,
    p_option_id,
    coalesce(p_enabled, true)
  )
  on conflict (batch_id, option_id)
  do update set
    enabled = excluded.enabled,
    updated_at = now();
end;
$$;

create or replace function public.get_event_addons_dynamic_setup(
  p_event_id uuid
)
returns table (
  apply_to_all_batches boolean,
  option_id uuid,
  option_name text,
  option_description text,
  option_sort_order integer,
  option_is_active boolean,
  batch_id uuid,
  batch_name text,
  batch_sequence_number integer,
  batch_option_enabled boolean
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with model as (
    select coalesce(m.apply_to_all_batches, true) as apply_to_all_batches
    from public.events e
    left join public.event_addons_model m on m.event_id = e.id
    where e.id = p_event_id
  )
  select
    m.apply_to_all_batches,
    o.id as option_id,
    o.name as option_name,
    o.description as option_description,
    o.sort_order as option_sort_order,
    o.is_active as option_is_active,
    b.id as batch_id,
    b.name as batch_name,
    b.sequence_number as batch_sequence_number,
    coalesce(ba.enabled, false) as batch_option_enabled
  from model m
  left join public.event_addon_options o
    on o.event_id = p_event_id
   and o.is_active = true
  left join public.registration_batches b
    on b.event_id = p_event_id
  left join public.event_batch_addon_options ba
    on ba.batch_id = b.id
   and ba.option_id = o.id
  order by o.sort_order asc nulls last, o.created_at asc, b.sequence_number asc nulls last, b.created_at asc;
$$;

grant execute on function public.upsert_event_addons_model(uuid, boolean)
to authenticated;

grant execute on function public.upsert_event_addon_option(uuid, text, text, integer, boolean, uuid)
to authenticated;

grant execute on function public.delete_event_addon_option(uuid, uuid)
to authenticated;

grant execute on function public.upsert_event_batch_addon_option(uuid, uuid, uuid, boolean)
to authenticated;

grant execute on function public.get_event_addons_dynamic_setup(uuid)
to authenticated;

commit;
