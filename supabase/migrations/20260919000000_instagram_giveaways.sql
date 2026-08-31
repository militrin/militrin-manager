begin;

create table public.instagram_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  instagram_user_id text not null,
  instagram_username text not null,
  encrypted_access_token text,
  token_expires_at timestamptz,
  connected_by uuid not null references auth.users(id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disconnected_at timestamptz,
  disconnected_by uuid references auth.users(id),
  check ((disconnected_at is null and encrypted_access_token is not null) or (disconnected_at is not null and encrypted_access_token is null)),
  unique (organization_id, instagram_user_id)
);

create unique index instagram_integrations_one_active_org_idx
  on public.instagram_integrations(organization_id)
  where disconnected_at is null;

create or replace function public.connect_instagram_integration(
  p_organization_id uuid, p_instagram_user_id text, p_instagram_username text,
  p_encrypted_access_token text, p_token_expires_at timestamptz, p_actor_user_id uuid
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_id uuid;
begin
  update public.instagram_integrations
  set encrypted_access_token = null, disconnected_at = now(), disconnected_by = p_actor_user_id, updated_at = now()
  where organization_id = p_organization_id and disconnected_at is null;

  insert into public.instagram_integrations (
    organization_id, instagram_user_id, instagram_username, encrypted_access_token,
    token_expires_at, connected_by, connected_at, disconnected_at, disconnected_by, updated_at
  ) values (
    p_organization_id, p_instagram_user_id, p_instagram_username, p_encrypted_access_token,
    p_token_expires_at, p_actor_user_id, now(), null, null, now()
  )
  on conflict (organization_id, instagram_user_id) do update set
    instagram_username = excluded.instagram_username,
    encrypted_access_token = excluded.encrypted_access_token,
    token_expires_at = excluded.token_expires_at,
    connected_by = excluded.connected_by,
    connected_at = now(), disconnected_at = null, disconnected_by = null, updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.connect_instagram_integration(uuid,text,text,text,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.connect_instagram_integration(uuid,text,text,text,timestamptz,uuid) to service_role;

create table public.giveaways (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  public_id text not null,
  source text not null check (source in ('csv', 'instagram')),
  status text not null check (status in ('empty','ready','drawing','awaiting_validation','finalized')),
  source_file_name text,
  instagram_integration_id uuid references public.instagram_integrations(id) on delete restrict,
  instagram_media_id text,
  instagram_media_permalink text,
  instagram_media_caption text,
  imported_at timestamptz,
  synced_at timestamptz,
  snapshot_frozen_at timestamptz,
  current_winner_comment_id text,
  current_draw_at timestamptz,
  confirmed_winner_comment_id text,
  confirmed_at timestamptz,
  state jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, public_id)
);

create table public.giveaway_entries (
  id uuid primary key default gen_random_uuid(),
  giveaway_id uuid not null references public.giveaways(id) on delete cascade,
  comment_id text not null,
  entry_number integer not null,
  author_username text not null,
  comment_text text not null default '',
  mentions jsonb not null default '[]'::jsonb,
  comment_url text,
  comment_created_at timestamptz,
  status text not null default 'active' check (status in ('active','disqualified')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  raw_api jsonb,
  unique (giveaway_id, comment_id)
);

create table public.giveaway_audit_events (
  id uuid primary key default gen_random_uuid(),
  giveaway_id uuid not null references public.giveaways(id) on delete cascade,
  external_event_id text not null,
  event_type text not null,
  message text not null,
  detail text,
  actor_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (giveaway_id, external_event_id)
);

create index giveaway_entries_giveaway_idx on public.giveaway_entries(giveaway_id, entry_number);
create index giveaway_audit_events_giveaway_idx on public.giveaway_audit_events(giveaway_id, created_at);

-- A aplicacao tambem valida estas invariantes, mas os triggers impedem que
-- service_role, concorrencia entre abas ou codigo futuro alterem o snapshot.
create or replace function public.protect_frozen_giveaway_source()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  if old.snapshot_frozen_at is not null and (
    new.organization_id is distinct from old.organization_id or
    new.source is distinct from old.source or
    new.public_id is distinct from old.public_id or
    new.source_file_name is distinct from old.source_file_name or
    new.instagram_integration_id is distinct from old.instagram_integration_id or
    new.instagram_media_id is distinct from old.instagram_media_id or
    new.instagram_media_permalink is distinct from old.instagram_media_permalink or
    new.instagram_media_caption is distinct from old.instagram_media_caption or
    new.imported_at is distinct from old.imported_at or
    new.synced_at is distinct from old.synced_at or
    new.snapshot_frozen_at is distinct from old.snapshot_frozen_at
  ) then
    raise exception 'Snapshot congelado: origem e publicacao sao imutaveis.';
  end if;
  return new;
end;
$$;

create trigger giveaways_protect_frozen_source
before update on public.giveaways
for each row execute function public.protect_frozen_giveaway_source();

create or replace function public.protect_frozen_giveaway_entries()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
declare v_giveaway_id uuid;
declare v_frozen boolean;
begin
  if tg_op = 'DELETE' then v_giveaway_id := old.giveaway_id; else v_giveaway_id := new.giveaway_id; end if;
  select snapshot_frozen_at is not null into v_frozen from public.giveaways where id = v_giveaway_id;
  if not coalesce(v_frozen, false) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op in ('INSERT', 'DELETE') then
    raise exception 'Snapshot congelado: participacoes nao podem ser adicionadas ou removidas.';
  end if;
  if new.id is distinct from old.id or new.giveaway_id is distinct from old.giveaway_id or new.comment_id is distinct from old.comment_id or
     new.entry_number is distinct from old.entry_number or new.author_username is distinct from old.author_username or
     new.comment_text is distinct from old.comment_text or new.mentions is distinct from old.mentions or
     new.comment_url is distinct from old.comment_url or new.comment_created_at is distinct from old.comment_created_at or
     new.first_seen_at is distinct from old.first_seen_at or new.raw_api is distinct from old.raw_api then
    raise exception 'Snapshot congelado: dados originais da participacao sao imutaveis.';
  end if;
  return new;
end;
$$;

create trigger giveaway_entries_protect_frozen
before insert or update or delete on public.giveaway_entries
for each row execute function public.protect_frozen_giveaway_entries();

alter table public.instagram_integrations enable row level security;
alter table public.giveaways enable row level security;
alter table public.giveaway_entries enable row level security;
alter table public.giveaway_audit_events enable row level security;

-- Tokens nunca ficam visiveis ao cliente autenticado. Somente o backend com
-- service_role acessa instagram_integrations.
revoke all on public.instagram_integrations from anon, authenticated;
grant all on public.instagram_integrations to service_role;

create policy giveaways_org_select on public.giveaways for select to authenticated
  using (public.user_can_access_organization(auth.uid(), organization_id));
create policy giveaway_entries_org_select on public.giveaway_entries for select to authenticated
  using (exists (select 1 from public.giveaways g where g.id = giveaway_id and public.user_can_access_organization(auth.uid(), g.organization_id)));
create policy giveaway_audit_org_select on public.giveaway_audit_events for select to authenticated
  using (exists (select 1 from public.giveaways g where g.id = giveaway_id and public.user_can_access_organization(auth.uid(), g.organization_id)));

grant select on public.giveaways, public.giveaway_entries, public.giveaway_audit_events to authenticated;
grant all on public.giveaways, public.giveaway_entries, public.giveaway_audit_events to service_role;

commit;
