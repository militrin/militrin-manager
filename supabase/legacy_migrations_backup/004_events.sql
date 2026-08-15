create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  year integer not null,
  registration_open timestamptz not null default now(),
  registration_close timestamptz,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.events (name, year, registration_open, registration_close, is_active)
select 'Militrin 2026', 2026, now(), now() + interval '90 days', true
where not exists (
  select 1
  from public.events
  where name = 'Militrin 2026' and year = 2026
);

do $$
begin
  if to_regclass('public.participants') is not null then
    alter table public.participants add column if not exists event_id uuid;
  end if;

  if to_regclass('public.payments') is not null then
    alter table public.payments add column if not exists event_id uuid;
  end if;

  if to_regclass('public.shirt_inventory') is not null then
    alter table public.shirt_inventory add column if not exists event_id uuid;
  end if;

  if to_regclass('public.kit_deliveries') is not null then
    alter table public.kit_deliveries add column if not exists event_id uuid;
  end if;

  if to_regclass('public.audit_logs') is not null then
    alter table public.audit_logs add column if not exists event_id uuid;
  end if;
end $$;

do $$
begin
  if to_regclass('public.participants') is not null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'participants'
         and column_name = 'event_id'
     )
     and not exists (
       select 1
       from pg_constraint
       where conname = 'participants_event_id_fkey'
     ) then
    alter table public.participants
      add constraint participants_event_id_fkey
      foreign key (event_id) references public.events(id) on delete set null;
  end if;

  if to_regclass('public.payments') is not null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'payments'
         and column_name = 'event_id'
     )
     and not exists (
       select 1
       from pg_constraint
       where conname = 'payments_event_id_fkey'
     ) then
    alter table public.payments
      add constraint payments_event_id_fkey
      foreign key (event_id) references public.events(id) on delete set null;
  end if;

  if to_regclass('public.shirt_inventory') is not null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'shirt_inventory'
         and column_name = 'event_id'
     )
     and not exists (
       select 1
       from pg_constraint
       where conname = 'shirt_inventory_event_id_fkey'
     ) then
    alter table public.shirt_inventory
      add constraint shirt_inventory_event_id_fkey
      foreign key (event_id) references public.events(id) on delete set null;
  end if;

  if to_regclass('public.kit_deliveries') is not null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'kit_deliveries'
         and column_name = 'event_id'
     )
     and not exists (
       select 1
       from pg_constraint
       where conname = 'kit_deliveries_event_id_fkey'
     ) then
    alter table public.kit_deliveries
      add constraint kit_deliveries_event_id_fkey
      foreign key (event_id) references public.events(id) on delete set null;
  end if;

  if to_regclass('public.audit_logs') is not null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'audit_logs'
         and column_name = 'event_id'
     )
     and not exists (
       select 1
       from pg_constraint
       where conname = 'audit_logs_event_id_fkey'
     ) then
    alter table public.audit_logs
      add constraint audit_logs_event_id_fkey
      foreign key (event_id) references public.events(id) on delete set null;
  end if;
end $$;

do $$
declare
  v_event_id uuid;
begin
  select id into v_event_id
  from public.events
  where is_active = true
  order by created_at desc
  limit 1;

  if v_event_id is not null then
    if to_regclass('public.participants') is not null
       and exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'participants'
           and column_name = 'event_id'
       ) then
      update public.participants
      set event_id = v_event_id
      where event_id is null;
    end if;

    if to_regclass('public.payments') is not null
       and exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'payments'
           and column_name = 'event_id'
       ) then
      update public.payments
      set event_id = v_event_id
      where event_id is null;
    end if;

    if to_regclass('public.shirt_inventory') is not null
       and exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'shirt_inventory'
           and column_name = 'event_id'
       ) then
      update public.shirt_inventory
      set event_id = v_event_id
      where event_id is null;
    end if;

    if to_regclass('public.kit_deliveries') is not null
       and exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'kit_deliveries'
           and column_name = 'event_id'
       ) then
      update public.kit_deliveries
      set event_id = v_event_id
      where event_id is null;
    end if;

    if to_regclass('public.audit_logs') is not null
       and exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = 'audit_logs'
           and column_name = 'event_id'
       ) then
      update public.audit_logs
      set event_id = v_event_id
      where event_id is null;
    end if;
  end if;
end $$;
