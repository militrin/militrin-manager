create extension if not exists pgcrypto;

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid,
  full_name text not null,
  cpf text not null,
  birth_date date not null,
  gender text,
  phone text not null,
  email text,
  city text,
  shirt_type text not null,
  shirt_size text not null,
  registration_status text not null default 'pending',
  amount numeric(10,2) not null default 0,
  payment_method text,
  payment_status text default 'pending',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  event_id uuid,
  amount numeric(10,2) not null default 0,
  payment_method text,
  payment_status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists public.shirt_inventory (
  id uuid primary key default gen_random_uuid(),
  event_id uuid,
  shirt_type text not null,
  shirt_size text not null,
  total_quantity integer not null default 0,
  reserved_quantity integer not null default 0,
  delivered_quantity integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.kit_deliveries (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  event_id uuid,
  shirt_type text not null,
  shirt_size text not null,
  delivered_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor text not null default 'system',
  action text not null,
  entity_type text not null,
  entity_id uuid,
  event_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_participants_event_id on public.participants (event_id);
create index if not exists idx_payments_event_id on public.payments (event_id);
create index if not exists idx_payments_participant_id on public.payments (participant_id);
create index if not exists idx_shirt_inventory_event_id on public.shirt_inventory (event_id);
create index if not exists idx_kit_deliveries_event_id on public.kit_deliveries (event_id);
create index if not exists idx_audit_logs_event_id on public.audit_logs (event_id);
create index if not exists idx_audit_logs_entity_id on public.audit_logs (entity_id);
