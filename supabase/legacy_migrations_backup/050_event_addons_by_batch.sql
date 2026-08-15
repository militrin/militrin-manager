-- 050_event_addons_by_batch.sql
-- Configure event add-ons globally or by specific batch.

begin;

create table if not exists public.event_addons_config (
  event_id uuid primary key references public.events(id) on delete cascade,
  apply_to_all_batches boolean not null default true,
  kit_enabled boolean not null default false,
  custom_cup_enabled boolean not null default false,
  gifts_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.registration_batch_addons (
  batch_id uuid primary key references public.registration_batches(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  kit_enabled boolean not null default false,
  custom_cup_enabled boolean not null default false,
  gifts_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint registration_batch_addons_event_batch_key unique (event_id, batch_id)
);

create index if not exists idx_registration_batch_addons_event_id
  on public.registration_batch_addons (event_id);

create or replace function public.upsert_event_addons_config(
  p_event_id uuid,
  p_apply_to_all_batches boolean,
  p_kit_enabled boolean,
  p_custom_cup_enabled boolean,
  p_gifts_enabled boolean
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

  insert into public.event_addons_config (
    event_id,
    apply_to_all_batches,
    kit_enabled,
    custom_cup_enabled,
    gifts_enabled
  ) values (
    p_event_id,
    coalesce(p_apply_to_all_batches, true),
    coalesce(p_kit_enabled, false),
    coalesce(p_custom_cup_enabled, false),
    coalesce(p_gifts_enabled, false)
  )
  on conflict (event_id)
  do update set
    apply_to_all_batches = excluded.apply_to_all_batches,
    kit_enabled = excluded.kit_enabled,
    custom_cup_enabled = excluded.custom_cup_enabled,
    gifts_enabled = excluded.gifts_enabled,
    updated_at = now();

  if coalesce(p_apply_to_all_batches, true) = true then
    delete from public.registration_batch_addons
    where event_id = p_event_id;
  end if;
end;
$$;

create or replace function public.upsert_registration_batch_addons(
  p_event_id uuid,
  p_batch_id uuid,
  p_kit_enabled boolean,
  p_custom_cup_enabled boolean,
  p_gifts_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event_id is null or p_batch_id is null then
    raise exception 'Evento e lote obrigatorios.';
  end if;

  if not exists (
    select 1
    from public.registration_batches b
    where b.id = p_batch_id
      and b.event_id = p_event_id
  ) then
    raise exception 'Lote nao pertence ao evento informado.';
  end if;

  insert into public.registration_batch_addons (
    event_id,
    batch_id,
    kit_enabled,
    custom_cup_enabled,
    gifts_enabled
  ) values (
    p_event_id,
    p_batch_id,
    coalesce(p_kit_enabled, false),
    coalesce(p_custom_cup_enabled, false),
    coalesce(p_gifts_enabled, false)
  )
  on conflict (batch_id)
  do update set
    event_id = excluded.event_id,
    kit_enabled = excluded.kit_enabled,
    custom_cup_enabled = excluded.custom_cup_enabled,
    gifts_enabled = excluded.gifts_enabled,
    updated_at = now();
end;
$$;

create or replace function public.get_event_addons_setup(
  p_event_id uuid
)
returns table (
  event_id uuid,
  apply_to_all_batches boolean,
  default_kit_enabled boolean,
  default_custom_cup_enabled boolean,
  default_gifts_enabled boolean,
  batch_id uuid,
  batch_name text,
  batch_sequence_number integer,
  batch_kit_enabled boolean,
  batch_custom_cup_enabled boolean,
  batch_gifts_enabled boolean
)
language sql
security definer
set search_path = public, pg_temp
as $$
  with cfg as (
    select
      e.id as event_id,
      coalesce(c.apply_to_all_batches, true) as apply_to_all_batches,
      coalesce(c.kit_enabled, false) as default_kit_enabled,
      coalesce(c.custom_cup_enabled, false) as default_custom_cup_enabled,
      coalesce(c.gifts_enabled, false) as default_gifts_enabled
    from public.events e
    left join public.event_addons_config c on c.event_id = e.id
    where e.id = p_event_id
  )
  select
    cfg.event_id,
    cfg.apply_to_all_batches,
    cfg.default_kit_enabled,
    cfg.default_custom_cup_enabled,
    cfg.default_gifts_enabled,
    b.id as batch_id,
    b.name as batch_name,
    b.sequence_number as batch_sequence_number,
    coalesce(a.kit_enabled, cfg.default_kit_enabled) as batch_kit_enabled,
    coalesce(a.custom_cup_enabled, cfg.default_custom_cup_enabled) as batch_custom_cup_enabled,
    coalesce(a.gifts_enabled, cfg.default_gifts_enabled) as batch_gifts_enabled
  from cfg
  left join public.registration_batches b on b.event_id = cfg.event_id
  left join public.registration_batch_addons a on a.batch_id = b.id
  order by b.sequence_number asc nulls last, b.created_at asc;
$$;

grant execute on function public.upsert_event_addons_config(uuid, boolean, boolean, boolean, boolean)
to authenticated;

grant execute on function public.upsert_registration_batch_addons(uuid, uuid, boolean, boolean, boolean)
to authenticated;

grant execute on function public.get_event_addons_setup(uuid)
to authenticated;

commit;
