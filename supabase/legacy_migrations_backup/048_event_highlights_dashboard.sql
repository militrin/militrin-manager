-- 048_event_highlights_dashboard.sql
-- Featured events configuration for dashboard blocks.

begin;

create table if not exists public.event_highlights (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_highlights_event_id_key unique (event_id)
);

create index if not exists idx_event_highlights_sort_order
  on public.event_highlights (sort_order);

create index if not exists idx_event_highlights_is_active
  on public.event_highlights (is_active);

create or replace function public.upsert_event_highlight(
  p_event_id uuid,
  p_sort_order integer,
  p_is_active boolean default true
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

  insert into public.event_highlights (event_id, sort_order, is_active)
  values (p_event_id, coalesce(p_sort_order, 0), coalesce(p_is_active, true))
  on conflict (event_id)
  do update
    set sort_order = excluded.sort_order,
        is_active = excluded.is_active,
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.remove_event_highlight(
  p_event_id uuid
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

  delete from public.event_highlights
  where event_id = p_event_id;
end;
$$;

create or replace function public.get_featured_events_for_dashboard()
returns table (
  event_id uuid,
  sort_order integer,
  name text,
  slug text,
  starts_at timestamptz,
  ends_at timestamptz,
  location text,
  registration_enabled boolean,
  registration_open_at timestamptz,
  registration_close_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    e.id as event_id,
    coalesce(h.sort_order, 0) as sort_order,
    e.name,
    e.slug,
    e.starts_at,
    e.ends_at,
    e.location,
    e.registration_enabled,
    e.registration_open_at,
    e.registration_close_at
  from public.event_highlights h
  join public.events e on e.id = h.event_id
  where coalesce(h.is_active, true) = true
  order by coalesce(h.sort_order, 0) asc,
           e.starts_at asc nulls last,
           e.created_at desc;
$$;

grant execute on function public.upsert_event_highlight(uuid, integer, boolean)
to authenticated;

grant execute on function public.remove_event_highlight(uuid)
to authenticated;

grant execute on function public.get_featured_events_for_dashboard()
to authenticated;

grant execute on function public.get_featured_events_for_dashboard()
to anon;

commit;
