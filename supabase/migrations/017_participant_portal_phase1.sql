-- 017_participant_portal_phase1.sql
-- Base do portal do participante: perfil expandido, niveis, historico e RLS.

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

create or replace function public.touch_loyalty_tiers_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_loyalty_tiers_updated_at on public.loyalty_tiers;
create trigger trg_touch_loyalty_tiers_updated_at
before update on public.loyalty_tiers
for each row
execute function public.touch_loyalty_tiers_updated_at();

insert into public.loyalty_tiers (slug, name, badge, min_confirmed_participations, sort_order)
values
  ('novato', 'Novato', 'N', 0, 10),
  ('bronze', 'Bronze', 'B', 1, 20),
  ('prata', 'Prata', 'P', 3, 30),
  ('ouro', 'Ouro', 'O', 6, 40),
  ('diamante', 'Diamante', 'D', 10, 50),
  ('legend-militrin', 'Legend Militrin', 'L', 15, 60)
on conflict (slug)
do update set
  name = excluded.name,
  badge = excluded.badge,
  min_confirmed_participations = excluded.min_confirmed_participations,
  sort_order = excluded.sort_order,
  updated_at = now();

create table if not exists public.loyalty_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  loyalty_tier_id uuid references public.loyalty_tiers(id) on delete set null,
  confirmed_participations integer not null default 0,
  source text not null default 'system',
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_loyalty_history_user_created
  on public.loyalty_history (user_id, created_at desc);

create index if not exists idx_loyalty_history_tier
  on public.loyalty_history (loyalty_tier_id);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  addressee_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendships_status_check check (status in ('pending', 'accepted', 'rejected', 'blocked')),
  constraint friendships_not_self_check check (requester_user_id <> addressee_user_id)
);

create unique index if not exists ux_friendships_pair
  on public.friendships (requester_user_id, addressee_user_id);

create index if not exists idx_friendships_requester
  on public.friendships (requester_user_id, created_at desc);

create index if not exists idx_friendships_addressee
  on public.friendships (addressee_user_id, created_at desc);

create or replace function public.touch_friendships_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_friendships_updated_at on public.friendships;
create trigger trg_touch_friendships_updated_at
before update on public.friendships
for each row
execute function public.touch_friendships_updated_at();

alter table public.customer_profiles
  add column if not exists email text,
  add column if not exists loyalty_tier_id uuid references public.loyalty_tiers(id) on delete set null,
  add column if not exists loyalty_override boolean not null default false,
  add column if not exists loyalty_override_reason text,
  add column if not exists loyalty_updated_at timestamptz,
  add column if not exists show_in_participant_list boolean not null default true,
  add column if not exists allow_friend_requests boolean not null default true,
  add column if not exists profile_visibility text not null default 'participants';

update public.customer_profiles cp
set
  full_name = coalesce(nullif(trim(cp.full_name), ''), nullif(trim(p.full_name), ''), nullif(split_part(au.email, '@', 1), ''), 'Participante'),
  email = coalesce(nullif(trim(cp.email), ''), lower(au.email), lower(p.email)),
  profile_visibility = coalesce(nullif(trim(cp.profile_visibility), ''), 'participants'),
  show_in_participant_list = coalesce(cp.show_in_participant_list, true),
  allow_friend_requests = coalesce(cp.allow_friend_requests, true),
  loyalty_override = coalesce(cp.loyalty_override, false)
from auth.users au
left join public.participants p
  on p.user_id = cp.user_id
where cp.user_id = au.id;

update public.customer_profiles
set
  full_name = coalesce(nullif(trim(full_name), ''), 'Participante'),
  email = coalesce(nullif(trim(email), ''), 'participante@militrin.local'),
  profile_visibility = coalesce(nullif(trim(profile_visibility), ''), 'participants'),
  show_in_participant_list = coalesce(show_in_participant_list, true),
  allow_friend_requests = coalesce(allow_friend_requests, true),
  loyalty_override = coalesce(loyalty_override, false);

alter table public.customer_profiles
  alter column full_name set not null,
  alter column email set not null,
  alter column loyalty_override set default false,
  alter column show_in_participant_list set default true,
  alter column allow_friend_requests set default true,
  alter column profile_visibility set default 'participants';

alter table public.customer_profiles
  drop constraint if exists customer_profiles_profile_visibility_check;

alter table public.customer_profiles
  add constraint customer_profiles_profile_visibility_check
  check (profile_visibility in ('participants', 'friends', 'private'));

create unique index if not exists ux_customer_profiles_email
  on public.customer_profiles (lower(email));

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
    p_loyalty_tier_id,
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
    loyalty_tier_id = coalesce(excluded.loyalty_tier_id, public.customer_profiles.loyalty_tier_id),
    loyalty_override = coalesce(excluded.loyalty_override, public.customer_profiles.loyalty_override),
    loyalty_override_reason = excluded.loyalty_override_reason,
    show_in_participant_list = coalesce(excluded.show_in_participant_list, true),
    allow_friend_requests = coalesce(excluded.allow_friend_requests, true),
    profile_visibility = coalesce(excluded.profile_visibility, 'participants'),
    loyalty_updated_at = case
      when excluded.loyalty_tier_id is not null or coalesce(excluded.loyalty_override, false) then now()
      else public.customer_profiles.loyalty_updated_at
    end,
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

  select count(*)::integer into v_confirmed_count
  from public.orders
  where user_id = p_user_id
    and status = 'confirmed';

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
    'recalculo automatico'
  );

  return v_target_tier.id;
end;
$$;

alter table public.loyalty_tiers enable row level security;
alter table public.loyalty_history enable row level security;
alter table public.friendships enable row level security;

drop policy if exists "loyalty_tiers_authenticated_select" on public.loyalty_tiers;

create policy "loyalty_tiers_authenticated_select"
on public.loyalty_tiers
for select
to authenticated
using (true);

drop policy if exists "loyalty_history_owner_select" on public.loyalty_history;

create policy "loyalty_history_owner_select"
on public.loyalty_history
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "friendships_owner_select" on public.friendships;

create policy "friendships_owner_select"
on public.friendships
for select
to authenticated
using (auth.uid() = requester_user_id or auth.uid() = addressee_user_id);

drop policy if exists "friendships_owner_insert" on public.friendships;

create policy "friendships_owner_insert"
on public.friendships
for insert
to authenticated
with check (auth.uid() = requester_user_id);

drop policy if exists "friendships_owner_update" on public.friendships;

create policy "friendships_owner_update"
on public.friendships
for update
to authenticated
using (auth.uid() = requester_user_id or auth.uid() = addressee_user_id)
with check (auth.uid() = requester_user_id or auth.uid() = addressee_user_id);

revoke all on function public.upsert_customer_profile(uuid, text, text, date, text, text, text, text, uuid, boolean, text, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.get_customer_profile(uuid) from public, anon, authenticated;
revoke all on function public.recalculate_customer_loyalty(uuid) from public, anon, authenticated;

grant execute on function public.upsert_customer_profile(uuid, text, text, date, text, text, text, text, uuid, boolean, text, boolean, boolean, text) to authenticated;
grant execute on function public.get_customer_profile(uuid) to authenticated;
grant execute on function public.recalculate_customer_loyalty(uuid) to authenticated;