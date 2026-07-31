-- 020_customer_profile_activation_fields.sql
-- Idempotent activation/account fields for customer_profiles.

alter table if exists public.customer_profiles
  add column if not exists account_status text not null default 'active',
  add column if not exists must_complete_profile boolean not null default false,
  add column if not exists must_change_password boolean not null default false,
  add column if not exists imported_at timestamptz,
  add column if not exists activation_completed_at timestamptz;

alter table if exists public.customer_profiles
  drop constraint if exists customer_profiles_account_status_check;

alter table if exists public.customer_profiles
  add constraint customer_profiles_account_status_check
  check (account_status in ('pending_activation', 'active', 'blocked', 'legacy_without_account'));
