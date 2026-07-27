-- 018_customer_profile_loyalty_init.sql
-- Inicializacao e backfill do nivel padrao do cliente no portal do participante.

create extension if not exists pgcrypto;

create table if not exists public.loyalty_tiers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  badge text not null,
  min_confirmed_participations integer not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint loyalty_tiers_min_confirmed_participations_check check (min_confirmed_participations >= 0)
);

insert into public.loyalty_tiers (slug, name, badge, min_confirmed_participations, sort_order)
values
  ('novato', 'Novato', 'N', 0, 10),
  ('bronze', 'Bronze', 'B', 1, 20),
  ('prata', 'Prata', 'P', 2, 30),
  ('ouro', 'Ouro', 'O', 5, 40),
  ('diamante', 'Diamante', 'D', 6, 50),
  ('legend-militrin', 'Legend Militrin', 'L', 10, 60)
on conflict (slug)
do update set
  name = excluded.name,
  badge = excluded.badge,
  min_confirmed_participations = excluded.min_confirmed_participations,
  sort_order = excluded.sort_order,
  updated_at = now();

create or replace function public.get_default_loyalty_tier_id()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tier_id uuid;
begin
  select id
  into v_tier_id
  from public.loyalty_tiers
  order by min_confirmed_participations asc, sort_order asc, name asc
  limit 1;

  if v_tier_id is null then
    raise exception 'Nenhum nivel de fidelidade configurado.';
  end if;

  return v_tier_id;
end;
$$;

alter table public.customer_profiles
  add column if not exists email text,
  add column if not exists loyalty_tier_id uuid references public.loyalty_tiers(id) on delete set null,
  add column if not exists loyalty_override boolean not null default false,
  add column if not exists loyalty_override_reason text,
  add column if not exists loyalty_updated_at timestamptz,
  add column if not exists show_in_participant_list boolean not null default true,
  add column if not exists allow_friend_requests boolean not null default true,
  add column if not exists profile_visibility text not null default 'participants';

update public.customer_profiles
set
  loyalty_tier_id = coalesce(loyalty_tier_id, public.get_default_loyalty_tier_id()),
  loyalty_override = coalesce(loyalty_override, false),
  loyalty_updated_at = coalesce(loyalty_updated_at, now()),
  show_in_participant_list = coalesce(show_in_participant_list, true),
  allow_friend_requests = coalesce(allow_friend_requests, true),
  profile_visibility = coalesce(nullif(trim(coalesce(profile_visibility, '')), ''), 'participants')
where loyalty_tier_id is null;

alter table public.customer_profiles
  alter column loyalty_tier_id set default public.get_default_loyalty_tier_id(),
  alter column loyalty_tier_id set not null,
  alter column loyalty_override set default false,
  alter column show_in_participant_list set default true,
  alter column allow_friend_requests set default true,
  alter column profile_visibility set default 'participants';

drop trigger if exists trg_touch_customer_profiles_loyalty_defaults on public.customer_profiles;

create or replace function public.touch_customer_profiles_loyalty_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.loyalty_override := coalesce(new.loyalty_override, false);
  new.show_in_participant_list := coalesce(new.show_in_participant_list, true);
  new.allow_friend_requests := coalesce(new.allow_friend_requests, true);
  new.profile_visibility := coalesce(nullif(trim(coalesce(new.profile_visibility, '')), ''), 'participants');

  if new.loyalty_tier_id is null then
    new.loyalty_tier_id := public.get_default_loyalty_tier_id();
    new.loyalty_updated_at := now();
  elsif new.loyalty_updated_at is null then
    new.loyalty_updated_at := now();
  end if;

  return new;
end;
$$;

create trigger trg_touch_customer_profiles_loyalty_defaults
before insert or update on public.customer_profiles
for each row
execute function public.touch_customer_profiles_loyalty_defaults();

create or replace function public.upsert_customer_profile(
  p_user_id uuid,
  p_full_name text,
  p_cpf text,
  p_birth_date date,
  p_gender text,
  p_phone text,
  p_email text,
  p_city text,
  p_loyalty_tier_id uuid default null,
  p_loyalty_override boolean default false,
  p_loyalty_override_reason text default null,
  p_show_in_participant_list boolean default true,
  p_allow_friend_requests boolean default true,
  p_profile_visibility text default 'participants'
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    raise exception 'Usuario obrigatorio.';
  end if;

  insert into public.customer_profiles (
    user_id,
    full_name,
    cpf,
    birth_date,
    gender,
    phone,
    email,
    city,
    loyalty_tier_id,
    loyalty_override,
    loyalty_override_reason,
    show_in_participant_list,
    allow_friend_requests,
    profile_visibility,
    loyalty_updated_at
  ) values (
    p_user_id,
    nullif(trim(coalesce(p_full_name, '')), ''),
    nullif(trim(coalesce(p_cpf, '')), ''),
    p_birth_date,
    nullif(trim(coalesce(p_gender, '')), ''),
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(lower(trim(coalesce(p_email, ''))), ''),
    nullif(trim(coalesce(p_city, '')), ''),
    coalesce(p_loyalty_tier_id, public.get_default_loyalty_tier_id()),
    coalesce(p_loyalty_override, false),
    nullif(trim(coalesce(p_loyalty_override_reason, '')), ''),
    coalesce(p_show_in_participant_list, true),
    coalesce(p_allow_friend_requests, true),
    coalesce(nullif(trim(coalesce(p_profile_visibility, '')), ''), 'participants'),
    now()
  )
  on conflict (user_id)
  do update set
    full_name = excluded.full_name,
    cpf = excluded.cpf,
    birth_date = excluded.birth_date,
    gender = excluded.gender,
    phone = excluded.phone,
    email = excluded.email,
    city = excluded.city,
    loyalty_tier_id = coalesce(excluded.loyalty_tier_id, public.customer_profiles.loyalty_tier_id, public.get_default_loyalty_tier_id()),
    loyalty_override = coalesce(excluded.loyalty_override, public.customer_profiles.loyalty_override, false),
    loyalty_override_reason = excluded.loyalty_override_reason,
    show_in_participant_list = coalesce(excluded.show_in_participant_list, true),
    allow_friend_requests = coalesce(excluded.allow_friend_requests, true),
    profile_visibility = coalesce(excluded.profile_visibility, 'participants'),
    loyalty_updated_at = now(),
    updated_at = now();

  return true;
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
    cp.created_at,
    cp.updated_at
  from public.customer_profiles cp
  left join public.loyalty_tiers lt
    on lt.id = cp.loyalty_tier_id
  where cp.user_id = p_user_id;
$$;

revoke all on function public.get_default_loyalty_tier_id() from public, anon, authenticated;
revoke all on function public.touch_customer_profiles_loyalty_defaults() from public, anon, authenticated;
revoke all on function public.upsert_customer_profile(uuid, text, text, date, text, text, text, text, uuid, boolean, text, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.get_customer_profile(uuid) from public, anon, authenticated;

grant execute on function public.get_default_loyalty_tier_id() to authenticated;
grant execute on function public.upsert_customer_profile(uuid, text, text, date, text, text, text, text, uuid, boolean, text, boolean, boolean, text) to authenticated;
grant execute on function public.get_customer_profile(uuid) to authenticated;