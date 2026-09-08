begin;

-- Estados OAuth temporários (nonce → admin + organização).
-- Não altera sorteios, snapshots nem integrações existentes.

create table if not exists public.instagram_oauth_states (
  state text primary key,
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint instagram_oauth_states_state_len
    check (char_length(state) between 32 and 86),
  constraint instagram_oauth_states_expiry
    check (expires_at > created_at)
);

create index if not exists instagram_oauth_states_expires_at_idx
  on public.instagram_oauth_states (expires_at);

alter table public.instagram_oauth_states enable row level security;
revoke all on public.instagram_oauth_states from public, anon, authenticated;
grant all on public.instagram_oauth_states to service_role;

create or replace function public.consume_instagram_oauth_state(p_state text)
returns table(admin_user_id uuid, organization_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state text := btrim(coalesce(p_state, ''));
begin
  if v_state = '' or char_length(v_state) < 32 or char_length(v_state) > 86 then
    return;
  end if;

  delete from public.instagram_oauth_states
  where expires_at < now()
     or (consumed_at is not null and consumed_at < now() - interval '1 day');

  return query
  update public.instagram_oauth_states as row
  set consumed_at = now()
  where row.state = v_state
    and row.consumed_at is null
    and row.expires_at > now()
  returning row.admin_user_id, row.organization_id;
end;
$$;

revoke all on function public.consume_instagram_oauth_state(text) from public, anon, authenticated;
grant execute on function public.consume_instagram_oauth_state(text) to service_role;

commit;
