-- 019_import_participation_history.sql
-- Importacao de participantes/historico + primeiro acesso seguro para contas importadas.

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

drop trigger if exists trg_touch_participation_history_updated_at on public.participation_history;
create trigger trg_touch_participation_history_updated_at
before update on public.participation_history
for each row
execute function public.touch_participation_history_updated_at();

alter table public.customer_profiles
  add column if not exists account_status text not null default 'active',
  add column if not exists must_complete_profile boolean not null default false,
  add column if not exists must_change_password boolean not null default false,
  add column if not exists imported_at timestamptz,
  add column if not exists activation_completed_at timestamptz;

alter table public.customer_profiles
  drop constraint if exists customer_profiles_account_status_check;

alter table public.customer_profiles
  add constraint customer_profiles_account_status_check
  check (account_status in ('pending_activation', 'active', 'blocked', 'legacy_without_account'));

create index if not exists idx_customer_profiles_account_status
  on public.customer_profiles (account_status, must_change_password, must_complete_profile);

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

create or replace function public.link_participation_history_by_cpf(
  p_user_id uuid,
  p_cpf text,
  p_actor text default 'system'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cpf text;
  v_affected integer := 0;
begin
  if p_user_id is null then
    raise exception 'Usuario obrigatorio.';
  end if;

  v_cpf := public.normalize_cpf(p_cpf);

  if v_cpf is null then
    return 0;
  end if;

  update public.participation_history ph
  set user_id = p_user_id,
      updated_at = now()
  where public.normalize_cpf(ph.cpf) = v_cpf
    and (ph.user_id is null or ph.user_id = p_user_id)
    and ph.status in ('confirmed', 'pending', 'review_required');

  get diagnostics v_affected = row_count;

  update public.participants p
  set user_id = p_user_id,
      updated_at = now()
  where public.normalize_cpf(p.cpf) = v_cpf
    and (p.user_id is null or p.user_id = p_user_id);

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    details
  ) values (
    coalesce(nullif(trim(coalesce(p_actor, '')), ''), 'system'),
    'participation_history_linked_by_cpf',
    'customer_profiles',
    p_user_id,
    jsonb_build_object('cpf_masked', left(v_cpf, 3) || '***' || right(v_cpf, 2), 'rows_affected', v_affected)
  );

  return v_affected;
end;
$$;

create or replace function public.recalculate_customer_loyalty(
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_confirmed_count integer := 0;
  v_current_profile public.customer_profiles%rowtype;
  v_target_tier public.loyalty_tiers%rowtype;
begin
  if p_user_id is null then
    raise exception 'Usuario obrigatorio.';
  end if;

  select * into v_current_profile
  from public.customer_profiles
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Perfil do cliente nao encontrado.';
  end if;

  if v_current_profile.loyalty_override and v_current_profile.loyalty_tier_id is not null then
    return v_current_profile.loyalty_tier_id;
  end if;

  with confirmed_history as (
    select distinct
      coalesce('event:' || ph.event_id::text, 'legacy:' || ph.event_year::text || ':' || coalesce(ph.normalized_name, public.normalize_text_for_match(ph.full_name))) as participation_key
    from public.participation_history ph
    where ph.user_id = p_user_id
      and ph.status = 'confirmed'
  ),
  confirmed_orders as (
    select distinct
      'event:' || o.event_id::text as participation_key
    from public.orders o
    where o.user_id = p_user_id
      and o.status = 'confirmed'
  ),
  unioned as (
    select participation_key from confirmed_history
    union
    select participation_key from confirmed_orders
  )
  select count(*)::integer into v_confirmed_count
  from unioned;

  select * into v_target_tier
  from public.loyalty_tiers
  where min_confirmed_participations <= v_confirmed_count
  order by min_confirmed_participations desc, sort_order desc
  limit 1;

  if not found then
    select * into v_target_tier
    from public.loyalty_tiers
    order by min_confirmed_participations asc, sort_order asc
    limit 1;
  end if;

  update public.customer_profiles
  set
    loyalty_tier_id = v_target_tier.id,
    loyalty_updated_at = now(),
    updated_at = now()
  where user_id = p_user_id;

  insert into public.loyalty_history (
    user_id,
    loyalty_tier_id,
    confirmed_participations,
    source,
    reason
  ) values (
    p_user_id,
    v_target_tier.id,
    v_confirmed_count,
    'system',
    'recalculo automatico por historico + pedidos confirmados'
  );

  return v_target_tier.id;
end;
$$;

create or replace function public.get_customer_profile(
  p_user_id uuid default auth.uid()
)
returns table (
  user_id uuid,
  full_name text,
  cpf text,
  birth_date date,
  gender text,
  phone text,
  email text,
  city text,
  loyalty_tier_id uuid,
  loyalty_tier_name text,
  loyalty_tier_badge text,
  loyalty_override boolean,
  loyalty_override_reason text,
  loyalty_updated_at timestamptz,
  show_in_participant_list boolean,
  allow_friend_requests boolean,
  profile_visibility text,
  account_status text,
  must_complete_profile boolean,
  must_change_password boolean,
  imported_at timestamptz,
  activation_completed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    cp.user_id,
    cp.full_name,
    cp.cpf,
    cp.birth_date,
    cp.gender,
    cp.phone,
    cp.email,
    cp.city,
    cp.loyalty_tier_id,
    lt.name as loyalty_tier_name,
    lt.badge as loyalty_tier_badge,
    cp.loyalty_override,
    cp.loyalty_override_reason,
    cp.loyalty_updated_at,
    cp.show_in_participant_list,
    cp.allow_friend_requests,
    cp.profile_visibility,
    cp.account_status,
    cp.must_complete_profile,
    cp.must_change_password,
    cp.imported_at,
    cp.activation_completed_at,
    cp.created_at,
    cp.updated_at
  from public.customer_profiles cp
  left join public.loyalty_tiers lt
    on lt.id = cp.loyalty_tier_id
  where cp.user_id = p_user_id;
$$;

revoke all on function public.normalize_text_for_match(text) from public, anon, authenticated;
revoke all on function public.normalize_cpf(text) from public, anon, authenticated;
revoke all on function public.normalize_email(text) from public, anon, authenticated;
revoke all on function public.link_participation_history_by_cpf(uuid, text, text) from public, anon, authenticated;
revoke all on function public.recalculate_customer_loyalty(uuid) from public, anon, authenticated;
revoke all on function public.get_customer_profile(uuid) from public, anon, authenticated;

grant execute on function public.normalize_text_for_match(text) to authenticated;
grant execute on function public.normalize_cpf(text) to authenticated;
grant execute on function public.normalize_email(text) to authenticated;
grant execute on function public.link_participation_history_by_cpf(uuid, text, text) to authenticated;
grant execute on function public.recalculate_customer_loyalty(uuid) to authenticated;
grant execute on function public.get_customer_profile(uuid) to authenticated;
