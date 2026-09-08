begin;

-- Callbacks técnicos da Meta (deauthorize + data deletion).
-- Não apaga sorteios, ingressos, pedidos nem pagamentos.
-- Desconectar/anonymizar só a integração Instagram.

create table if not exists public.instagram_meta_data_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  confirmation_code text not null,
  instagram_user_id text not null,
  status text not null
    check (status in ('received', 'credentials_revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_meta_data_deletion_requests_code_len
    check (char_length(confirmation_code) between 32 and 86),
  constraint instagram_meta_data_deletion_requests_user_len
    check (char_length(instagram_user_id) between 1 and 128),
  constraint instagram_meta_data_deletion_requests_code_uidx unique (confirmation_code),
  constraint instagram_meta_data_deletion_requests_user_uidx unique (instagram_user_id)
);

alter table public.instagram_meta_data_deletion_requests enable row level security;
revoke all on public.instagram_meta_data_deletion_requests from public, anon, authenticated;
grant all on public.instagram_meta_data_deletion_requests to service_role;

create or replace function public.handle_instagram_deauthorize(p_instagram_user_id text)
returns table(disconnected_now integer, already_disconnected integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user text := btrim(coalesce(p_instagram_user_id, ''));
  v_now integer := 0;
  v_already integer := 0;
begin
  if v_user = '' or char_length(v_user) > 128 then
    raise exception 'user_id invalido.';
  end if;

  select
    count(*) filter (where disconnected_at is null)::integer,
    count(*) filter (where disconnected_at is not null)::integer
    into v_now, v_already
  from public.instagram_integrations
  where instagram_user_id = v_user;

  update public.instagram_integrations
  set
    encrypted_access_token = null,
    disconnected_at = coalesce(disconnected_at, now()),
    updated_at = now()
  where instagram_user_id = v_user
    and disconnected_at is null;

  insert into public.audit_logs (actor, action, entity_type, details)
  values (
    'meta',
    'INSTAGRAM_DEAUTHORIZED',
    'instagram_integration',
    jsonb_build_object(
      'instagram_user_id', v_user,
      'disconnected_now', v_now,
      'already_disconnected', v_already
    )
  );

  disconnected_now := v_now;
  already_disconnected := v_already;
  return next;
end;
$$;

revoke all on function public.handle_instagram_deauthorize(text) from public, anon, authenticated;
grant execute on function public.handle_instagram_deauthorize(text) to service_role;

create or replace function public.handle_instagram_data_deletion(
  p_instagram_user_id text,
  p_confirmation_code text
)
returns table(confirmation_code text, reused boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user text := btrim(coalesce(p_instagram_user_id, ''));
  v_code text := btrim(coalesce(p_confirmation_code, ''));
  v_existing public.instagram_meta_data_deletion_requests%rowtype;
  v_id uuid;
begin
  if v_user = '' or char_length(v_user) > 128 then
    raise exception 'user_id invalido.';
  end if;
  if char_length(v_code) < 32 or char_length(v_code) > 86 then
    raise exception 'confirmation_code invalido.';
  end if;

  select * into v_existing
  from public.instagram_meta_data_deletion_requests
  where instagram_user_id = v_user;

  if found then
    confirmation_code := v_existing.confirmation_code;
    reused := true;
    return next;
    return;
  end if;

  insert into public.instagram_meta_data_deletion_requests (
    confirmation_code, instagram_user_id, status
  ) values (
    v_code, v_user, 'received'
  )
  on conflict (instagram_user_id) do nothing
  returning id into v_id;

  if v_id is null then
    select r.confirmation_code into confirmation_code
    from public.instagram_meta_data_deletion_requests r
    where r.instagram_user_id = v_user;
    reused := true;
    return next;
    return;
  end if;

  update public.instagram_integrations
  set
    encrypted_access_token = null,
    disconnected_at = coalesce(disconnected_at, now()),
    instagram_username = 'deleted',
    instagram_user_id = 'deleted:' || id::text,
    updated_at = now()
  where instagram_user_id = v_user;

  update public.instagram_meta_data_deletion_requests
  set status = 'credentials_revoked', updated_at = now()
  where id = v_id;

  insert into public.audit_logs (actor, action, entity_type, entity_id, details)
  values (
    'meta',
    'INSTAGRAM_DATA_DELETION_REQUESTED',
    'instagram_meta_data_deletion_request',
    v_id,
    jsonb_build_object('instagram_user_id', v_user)
  );

  confirmation_code := v_code;
  reused := false;
  return next;
end;
$$;

revoke all on function public.handle_instagram_data_deletion(text, text) from public, anon, authenticated;
grant execute on function public.handle_instagram_data_deletion(text, text) to service_role;

create or replace function public.get_instagram_data_deletion_public_status(p_confirmation_code text)
returns table(status text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := btrim(coalesce(p_confirmation_code, ''));
begin
  if v_code !~ '^[A-Za-z0-9_-]{32,86}$' then
    return;
  end if;

  return query
  select r.status, r.created_at
  from public.instagram_meta_data_deletion_requests r
  where r.confirmation_code = v_code;
end;
$$;

revoke all on function public.get_instagram_data_deletion_public_status(text) from public;
grant execute on function public.get_instagram_data_deletion_public_status(text) to anon, authenticated, service_role;

commit;
