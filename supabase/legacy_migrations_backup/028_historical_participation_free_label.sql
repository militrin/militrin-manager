-- 027_historical_participation_free_label.sql
-- Rótulo livre para histórico de participações, com chave normalizada para deduplicação.

create extension if not exists pgcrypto;

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  import_type text not null,
  event_id uuid references public.events(id) on delete set null,
  total_rows integer not null default 0,
  imported_rows integer not null default 0,
  skipped_rows integer not null default 0,
  error_rows integer not null default 0,
  status text not null default 'processing',
  imported_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint import_batches_type_check check (import_type in ('historical_participations', 'current_event_registrations', 'inventory', 'payments')),
  constraint import_batches_status_check check (status in ('processing', 'ready_for_review', 'completed', 'failed', 'cancelled'))
);

create index if not exists idx_import_batches_type_status
  on public.import_batches (import_type, status, created_at desc);

create table if not exists public.import_batch_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.import_batches(id) on delete cascade,
  row_number integer not null,
  raw_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  status text not null default 'ready',
  resolution text not null default 'pending',
  error_message text,
  matched_participant_id uuid references public.participants(id) on delete set null,
  matched_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_batch_rows_status_check check (status in ('ready', 'review_required', 'duplicate', 'error', 'skipped', 'imported')),
  constraint import_batch_rows_resolution_check check (resolution in ('pending', 'link_existing', 'create_new', 'ignore', 'mark_duplicate')),
  constraint import_batch_rows_unique_row unique (import_batch_id, row_number)
);

create index if not exists idx_import_batch_rows_batch_status
  on public.import_batch_rows (import_batch_id, status, row_number);

create or replace function public.touch_import_batch_rows_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_import_batch_rows_updated_at on public.import_batch_rows;
create trigger trg_touch_import_batch_rows_updated_at
before update on public.import_batch_rows
for each row
execute function public.touch_import_batch_rows_updated_at();

create table if not exists public.participation_history (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  participant_id uuid references public.participants(id) on delete set null,
  legacy_event_name text,
  event_year integer not null,
  full_name text not null,
  normalized_name text,
  cpf text,
  email text,
  status text not null default 'confirmed',
  source text not null default 'import',
  import_batch_id uuid references public.import_batches(id) on delete set null,
  manually_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint participation_history_status_check check (status in ('confirmed', 'pending', 'cancelled', 'duplicate', 'review_required')),
  constraint participation_history_source_check check (source in ('import', 'system', 'manual'))
);

create index if not exists idx_participation_history_user_status
  on public.participation_history (user_id, status, event_year desc);

create index if not exists idx_participation_history_cpf
  on public.participation_history (cpf);

create index if not exists idx_participation_history_email
  on public.participation_history (lower(email));

create index if not exists idx_participation_history_event_year
  on public.participation_history (event_id, event_year desc);

create or replace function public.touch_participation_history_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.normalize_text_for_match(p_value text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    translate(lower(trim(coalesce(p_value, ''))), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
    '\s+',
    ' ',
    'g'
  );
$$;

create or replace function public.normalize_cpf(p_value text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(coalesce(p_value, ''), '\D', '', 'g'), '');
$$;

create or replace function public.normalize_email(p_value text)
returns text
language sql
immutable
as $$
  select nullif(lower(trim(coalesce(p_value, ''))), '');
$$;

drop trigger if exists trg_touch_participation_history_updated_at on public.participation_history;
create trigger trg_touch_participation_history_updated_at
before update on public.participation_history
for each row
execute function public.touch_participation_history_updated_at();

alter table if exists public.import_batches
  add column if not exists historical_event_label text,
  add column if not exists historical_event_key text,
  add column if not exists historical_event_year integer;

alter table if exists public.participation_history
  add column if not exists historical_event_label text,
  add column if not exists historical_event_key text;

alter table if exists public.participation_history
  add column if not exists historical_event_year integer;

create index if not exists idx_import_batches_historical_event_key
  on public.import_batches (historical_event_key);

create index if not exists idx_participation_history_historical_event_key
  on public.participation_history (historical_event_key);

update public.import_batches
set
  historical_event_label = nullif(trim(historical_event_label), ''),
  historical_event_key = coalesce(
    nullif(trim(historical_event_key), ''),
    public.slugify_text(nullif(trim(historical_event_label), ''))
  ),
  historical_event_year = coalesce(
    historical_event_year,
    nullif(substring(coalesce(historical_event_label, '') from '(19|20)[0-9]{2}'), '')::integer
  )
where import_type = 'historical_participations';

update public.participation_history
set
  normalized_name = coalesce(nullif(trim(normalized_name), ''), public.normalize_text_for_match(full_name)),
  cpf = public.normalize_cpf(cpf),
  email = public.normalize_email(email),
  historical_event_label = coalesce(nullif(trim(historical_event_label), ''), nullif(trim(legacy_event_name), '')),
  historical_event_key = coalesce(
    nullif(trim(historical_event_key), ''),
    public.slugify_text(
      coalesce(
        nullif(trim(coalesce(historical_event_label, legacy_event_name)), ''),
        nullif(trim(legacy_event_name), ''),
        event_year::text
      )
    )
  ),
  historical_event_year = coalesce(historical_event_year, event_year)
where historical_event_label is null
   or historical_event_key is null
   or trim(historical_event_key) = ''
   or historical_event_year is null;

with duplicated_confirmed_historical as (
  select
    id,
    row_number() over (
      partition by
        historical_event_key,
        coalesce(
          'cpf:' || public.normalize_cpf(cpf),
          'email:' || public.normalize_email(email),
          'name:' || coalesce(nullif(trim(normalized_name), ''), public.normalize_text_for_match(full_name))
        )
      order by created_at asc, id asc
    ) as rn
  from public.participation_history
  where event_id is null
    and historical_event_key is not null
    and coalesce(
      public.normalize_cpf(cpf),
      public.normalize_email(email),
      coalesce(nullif(trim(normalized_name), ''), public.normalize_text_for_match(full_name))
    ) is not null
    and status = 'confirmed'
)
update public.participation_history ph
set
  status = 'duplicate',
  updated_at = now()
from duplicated_confirmed_historical dch
where ph.id = dch.id
  and dch.rn > 1;

create unique index if not exists ux_participation_history_hist_key_cpf_confirmed
  on public.participation_history (historical_event_key, public.normalize_cpf(cpf))
  where event_id is null
    and historical_event_key is not null
    and public.normalize_cpf(cpf) is not null
    and status = 'confirmed';

create unique index if not exists ux_participation_history_hist_key_email_confirmed
  on public.participation_history (historical_event_key, public.normalize_email(email))
  where event_id is null
    and historical_event_key is not null
    and public.normalize_cpf(cpf) is null
    and public.normalize_email(email) is not null
    and status = 'confirmed';

create unique index if not exists ux_participation_history_hist_key_name_confirmed
  on public.participation_history (historical_event_key, coalesce(nullif(trim(normalized_name), ''), public.normalize_text_for_match(full_name)))
  where event_id is null
    and historical_event_key is not null
    and public.normalize_cpf(cpf) is null
    and public.normalize_email(email) is null
    and coalesce(nullif(trim(normalized_name), ''), public.normalize_text_for_match(full_name)) is not null
    and status = 'confirmed';

create unique index if not exists ux_participation_history_user_event_confirmed
  on public.participation_history (user_id, event_id)
  where user_id is not null
    and event_id is not null
    and status = 'confirmed';

-- A fidelidade fica fora da 027.
-- Uma migration futura dedicada pode calcular participacoes por pessoa com:
-- count(distinct historical_event_key) para historico sem event_id.

-- 029_loyalty_system.sql (futuro): loyalty_tiers, loyalty_history,
-- customer_profiles.loyalty_*, recalculate_customer_loyalty.

/* Bloco de fidelidade removido desta migration por escopo. */
