-- 068_multi_org_foundation.sql
-- Fundação multi-organização: organizations, organization_members, platform_users.
-- Militrin é criado como primeira organização; Owner atual vira platform owner e org owner.

begin;

-- ============================================================
-- 1. TABELAS
-- ============================================================

create table if not exists public.organizations (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null,
  slug         text        not null unique,
  legal_name   text,
  document     text,
  email        text,
  phone        text,
  status       text        not null default 'active'
                           check (status in ('active', 'trial', 'suspended', 'cancelled')),
  plan_code    text,
  trial_ends_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.organization_members (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null references public.organizations(id) on delete cascade,
  user_id         uuid        not null references auth.users(id) on delete cascade,
  role_id         uuid        references public.admin_roles(id),
  is_owner        boolean     not null default false,
  is_active       boolean     not null default true,
  joined_at       timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists public.platform_users (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  role       text        not null
                         check (role in ('owner', 'admin', 'support', 'finance', 'viewer')),
  is_active  boolean     not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Índices úteis
create index if not exists idx_org_members_org   on public.organization_members(organization_id);
create index if not exists idx_org_members_user  on public.organization_members(user_id);
create index if not exists idx_platform_users_active on public.platform_users(is_active);

-- ============================================================
-- 2. DADOS INICIAIS
-- ============================================================

-- Organização Militrin
insert into public.organizations (name, slug, status)
values ('Militrin', 'militrin', 'active')
on conflict (slug) do nothing;

-- Platform owner: todos os admin_users com role Owner ativo
insert into public.platform_users (user_id, role, is_active)
select au.user_id, 'owner', true
from public.admin_users au
join public.admin_roles ar on ar.id = au.role_id
where ar.name = 'Owner'
  and au.is_active = true
  and ar.is_active = true
on conflict (user_id) do update
  set role      = 'owner',
      is_active = true,
      updated_at = now();

-- Organization members: vincular owners à organização Militrin
insert into public.organization_members (organization_id, user_id, is_owner, is_active)
select
  (select id from public.organizations where slug = 'militrin'),
  au.user_id,
  true,
  true
from public.admin_users au
join public.admin_roles ar on ar.id = au.role_id
where ar.name = 'Owner'
  and au.is_active = true
  and ar.is_active = true
on conflict (organization_id, user_id) do update
  set is_owner  = true,
      is_active = true,
      updated_at = now();

-- Auditoria da migração (sem coluna actor)
insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
select
  'org_foundation_bootstrap',
  'organizations',
  o.id,
  null,
  jsonb_build_object(
    'actor', 'system',
    'slug', o.slug,
    'migration', '068_multi_org_foundation'
  )
from public.organizations o
where o.slug = 'militrin';

-- ============================================================
-- 3. HELPERS SQL
-- ============================================================

create or replace function public.is_platform_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
    from public.platform_users pu
    where pu.user_id = p_user_id
      and pu.is_active = true
  );
$$;

create or replace function public.is_platform_owner(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
    from public.platform_users pu
    where pu.user_id = p_user_id
      and pu.role = 'owner'
      and pu.is_active = true
  );
$$;

create or replace function public.is_organization_member(
  p_user_id       uuid,
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.user_id         = p_user_id
      and om.organization_id = p_organization_id
      and om.is_active = true
  );
$$;

create or replace function public.is_organization_owner(
  p_user_id         uuid,
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.user_id         = p_user_id
      and om.organization_id = p_organization_id
      and om.is_owner  = true
      and om.is_active = true
  );
$$;

create or replace function public.user_organization_ids(p_user_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  -- Platform owner enxerga todas as organizações ativas
  select id
  from public.organizations
  where public.is_platform_owner(p_user_id)
  union
  -- Membros ativos enxergam suas próprias organizações
  select om.organization_id
  from public.organization_members om
  where om.user_id  = p_user_id
    and om.is_active = true;
$$;

grant execute on function public.is_platform_user(uuid)           to authenticated;
grant execute on function public.is_platform_owner(uuid)          to authenticated;
grant execute on function public.is_organization_member(uuid, uuid) to authenticated;
grant execute on function public.is_organization_owner(uuid, uuid)  to authenticated;
grant execute on function public.user_organization_ids(uuid)       to authenticated;

-- ============================================================
-- 4. RLS
-- ============================================================

alter table public.organizations        enable row level security;
alter table public.organization_members enable row level security;
alter table public.platform_users       enable row level security;

-- Revogar acesso padrão
revoke all on table public.organizations        from public, anon, authenticated;
revoke all on table public.organization_members from public, anon, authenticated;
revoke all on table public.platform_users       from public, anon, authenticated;

-- Grants de tabela (acesso restrito via RLS)
grant select, insert, update on table public.organizations        to authenticated;
grant select, insert, update, delete on table public.organization_members to authenticated;
grant select, insert, update on table public.platform_users       to authenticated;

-- ------------------------------------------------------------
-- organizations policies
-- ------------------------------------------------------------

-- Leitura: platform_users ativos veem todas; membros ativos veem as suas
drop policy if exists "org_select_platform_users" on public.organizations;
create policy "org_select_platform_users"
  on public.organizations for select
  to authenticated
  using (
    public.is_platform_user(auth.uid())
    or public.is_organization_member(auth.uid(), id)
  );

-- Inserção/edição: somente platform owner ou admin
drop policy if exists "org_insert_platform_owner_admin" on public.organizations;
create policy "org_insert_platform_owner_admin"
  on public.organizations for insert
  to authenticated
  with check (
    exists (
      select 1 from public.platform_users pu
      where pu.user_id  = auth.uid()
        and pu.is_active = true
        and pu.role in ('owner', 'admin')
    )
  );

drop policy if exists "org_update_platform_owner_admin" on public.organizations;
create policy "org_update_platform_owner_admin"
  on public.organizations for update
  to authenticated
  using (
    exists (
      select 1 from public.platform_users pu
      where pu.user_id  = auth.uid()
        and pu.is_active = true
        and pu.role in ('owner', 'admin')
    )
  );

-- ------------------------------------------------------------
-- organization_members policies
-- ------------------------------------------------------------

-- Leitura: platform_users ou membro da mesma organização
drop policy if exists "org_members_select" on public.organization_members;
create policy "org_members_select"
  on public.organization_members for select
  to authenticated
  using (
    public.is_platform_user(auth.uid())
    or public.is_organization_member(auth.uid(), organization_id)
  );

-- Escrita: platform owner/admin ou org owner da própria organização
drop policy if exists "org_members_insert" on public.organization_members;
create policy "org_members_insert"
  on public.organization_members for insert
  to authenticated
  with check (
    exists (
      select 1 from public.platform_users pu
      where pu.user_id  = auth.uid()
        and pu.is_active = true
        and pu.role in ('owner', 'admin')
    )
    or public.is_organization_owner(auth.uid(), organization_id)
  );

drop policy if exists "org_members_update" on public.organization_members;
create policy "org_members_update"
  on public.organization_members for update
  to authenticated
  using (
    exists (
      select 1 from public.platform_users pu
      where pu.user_id  = auth.uid()
        and pu.is_active = true
        and pu.role in ('owner', 'admin')
    )
    or public.is_organization_owner(auth.uid(), organization_id)
  );

drop policy if exists "org_members_delete" on public.organization_members;
create policy "org_members_delete"
  on public.organization_members for delete
  to authenticated
  using (
    exists (
      select 1 from public.platform_users pu
      where pu.user_id  = auth.uid()
        and pu.is_active = true
        and pu.role in ('owner', 'admin')
    )
    or public.is_organization_owner(auth.uid(), organization_id)
  );

-- ------------------------------------------------------------
-- platform_users policies
-- ------------------------------------------------------------

-- Somente platform owner gerencia; usuário vê o próprio registro
drop policy if exists "platform_users_select" on public.platform_users;
create policy "platform_users_select"
  on public.platform_users for select
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or user_id = auth.uid()
  );

drop policy if exists "platform_users_insert" on public.platform_users;
create policy "platform_users_insert"
  on public.platform_users for insert
  to authenticated
  with check (
    public.is_platform_owner(auth.uid())
  );

drop policy if exists "platform_users_update" on public.platform_users;
create policy "platform_users_update"
  on public.platform_users for update
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
  );

commit;
