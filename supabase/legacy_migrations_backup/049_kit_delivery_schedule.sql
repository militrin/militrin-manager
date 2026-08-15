-- 049_kit_delivery_schedule.sql
-- Schedule of upcoming kit deliveries configured by admin.

begin;

create table if not exists public.kit_delivery_schedule (
  id uuid primary key default gen_random_uuid(),
  delivery_at timestamptz not null,
  city text not null,
  location text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_kit_delivery_schedule_order
  on public.kit_delivery_schedule (sort_order, delivery_at);

create index if not exists idx_kit_delivery_schedule_active
  on public.kit_delivery_schedule (is_active);

create or replace function public.upsert_kit_delivery_schedule(
  p_delivery_at timestamptz,
  p_city text,
  p_location text,
  p_id uuid default null,
  p_sort_order integer default 0,
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
  if p_delivery_at is null then
    raise exception 'Data e hora obrigatorias.';
  end if;

  if coalesce(trim(p_city), '') = '' then
    raise exception 'Cidade obrigatoria.';
  end if;

  if coalesce(trim(p_location), '') = '' then
    raise exception 'Local obrigatorio.';
  end if;

  if p_id is null then
    insert into public.kit_delivery_schedule (
      delivery_at,
      city,
      location,
      sort_order,
      is_active
    ) values (
      p_delivery_at,
      trim(p_city),
      trim(p_location),
      coalesce(p_sort_order, 0),
      coalesce(p_is_active, true)
    )
    returning id into v_id;
  else
    update public.kit_delivery_schedule
       set delivery_at = p_delivery_at,
           city = trim(p_city),
           location = trim(p_location),
           sort_order = coalesce(p_sort_order, 0),
           is_active = coalesce(p_is_active, true),
           updated_at = now()
     where id = p_id
    returning id into v_id;

    if v_id is null then
      raise exception 'Agenda de entrega nao encontrada.';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.delete_kit_delivery_schedule(
  p_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_id is null then
    raise exception 'Identificador obrigatorio.';
  end if;

  delete from public.kit_delivery_schedule where id = p_id;
end;
$$;

create or replace function public.get_upcoming_kit_deliveries(
  p_limit integer default 6
)
returns table (
  id uuid,
  delivery_at timestamptz,
  city text,
  location text,
  sort_order integer
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    k.id,
    k.delivery_at,
    k.city,
    k.location,
    k.sort_order
  from public.kit_delivery_schedule k
  where coalesce(k.is_active, true) = true
    and k.delivery_at >= now() - interval '12 hours'
  order by coalesce(k.sort_order, 0) asc,
           k.delivery_at asc
  limit greatest(coalesce(p_limit, 6), 1);
$$;

grant execute on function public.upsert_kit_delivery_schedule(timestamptz, text, text, uuid, integer, boolean)
to authenticated;

grant execute on function public.delete_kit_delivery_schedule(uuid)
to authenticated;

grant execute on function public.get_upcoming_kit_deliveries(integer)
to authenticated;

grant execute on function public.get_upcoming_kit_deliveries(integer)
to anon;

commit;
