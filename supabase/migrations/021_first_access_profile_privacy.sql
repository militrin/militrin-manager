-- 021_first_access_profile_privacy.sql
-- Add privacy acceptance fields required by first-access completion flow.

alter table if exists public.customer_profiles
  add column if not exists privacy_policy_accepted boolean not null default false;

alter table if exists public.customer_profiles
  add column if not exists privacy_policy_accepted_at timestamptz;

-- Keep current active users working after deploy by marking legacy profiles as accepted.
update public.customer_profiles
set
  privacy_policy_accepted = true,
  privacy_policy_accepted_at = coalesce(privacy_policy_accepted_at, now()),
  updated_at = now()
where
  account_status = 'active'
  and coalesce(must_complete_profile, false) = false
  and coalesce(privacy_policy_accepted, false) = false;
