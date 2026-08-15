-- 069_events_organization_scope.sql
-- Vincula todos os eventos à organização Militrin.
-- Adiciona organization_id a events, helpers, RLS e atualiza RPCs relevantes.

begin;

-- ============================================================
-- 1. COLUNA organization_id (nullable inicialmente)
-- ============================================================

alter table public.events
  add column if not exists organization_id uuid
    references public.organizations(id);

-- ============================================================
-- 2. BACKFILL
-- ============================================================

update public.events
set organization_id = (select id from public.organizations where slug = 'militrin')
where organization_id is null;

-- ============================================================
-- 3. NOT NULL + ÍNDICE
-- ============================================================

alter table public.events
  alter column organization_id set not null;

create index if not exists idx_events_organization_id on public.events(organization_id);

-- ============================================================
-- 4. HELPER: current_organization_id()
-- Retorna a primeira organização ativa do caller ou null se não tiver nenhuma.
-- A preferência por cookie é resolvida na camada TypeScript.
-- ============================================================

create or replace function public.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select organization_id
  from public.organization_members
  where user_id  = auth.uid()
    and is_active = true
  order by joined_at asc
  limit 1;
$$;

grant execute on function public.current_organization_id() to authenticated;

-- ============================================================
-- 5. ATUALIZAR create_event
-- Adiciona p_organization_id. Se null, usa current_organization_id().
-- Dropa versão antiga antes para evitar overload duplicado.
-- ============================================================

drop function if exists public.create_event(text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean);

create function public.create_event(
  p_name text,
  p_slug text,
  p_year integer default null,
  p_description text default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_registration_open_at timestamptz default null,
  p_registration_close_at timestamptz default null,
  p_location text default null,
  p_is_active boolean default false,
  p_registration_enabled boolean default false,
  p_kit_enabled boolean default false,
  p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id      uuid;
  v_slug          text;
  v_organization_id uuid;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Nome do evento obrigatorio.';
  end if;

  v_slug := public.slugify_text(
    coalesce(nullif(trim(p_slug), ''), p_name || '-' || coalesce(p_year::text, extract(year from now())::text))
  );
  if v_slug = '' then
    raise exception 'Slug do evento invalido.';
  end if;

  -- Resolve organização: parâmetro explícito → current_organization_id()
  v_organization_id := coalesce(p_organization_id, public.current_organization_id());
  if v_organization_id is null then
    raise exception 'Nenhuma organização encontrada para o usuário.';
  end if;

  if coalesce(p_is_active, false) then
    update public.events
    set is_active  = false,
        updated_at = now()
    where is_active = true;
  end if;

  insert into public.events (
    name,
    slug,
    year,
    description,
    starts_at,
    ends_at,
    registration_open_at,
    registration_close_at,
    location,
    is_active,
    registration_enabled,
    kit_enabled,
    organization_id
  ) values (
    trim(p_name),
    v_slug,
    p_year,
    nullif(trim(coalesce(p_description, '')), ''),
    p_starts_at,
    p_ends_at,
    p_registration_open_at,
    p_registration_close_at,
    nullif(trim(coalesce(p_location, '')), ''),
    coalesce(p_is_active, false),
    coalesce(p_registration_enabled, false),
    coalesce(p_kit_enabled, false),
    v_organization_id
  ) returning id into v_event_id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'event_created',
    'events',
    v_event_id,
    v_event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'name', trim(p_name),
      'slug', v_slug,
      'year', p_year,
      'organization_id', v_organization_id,
      'is_active', coalesce(p_is_active, false)
    )
  );

  return v_event_id;
end;
$$;

revoke all on function public.create_event(text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.create_event(text, text, integer, text, timestamptz, timestamptz, timestamptz, timestamptz, text, boolean, boolean, boolean, uuid)
  to authenticated;

-- ============================================================
-- 6. ATUALIZAR get_events_overview
-- Platform owner vê todos; demais veem apenas eventos da(s) própria(s) organização(ões).
-- anon e usuários sem organização não veem nada via esta função.
-- ============================================================

create or replace function public.get_events_overview()
returns table (
  id                    uuid,
  name                  text,
  slug                  text,
  year                  integer,
  description           text,
  starts_at             timestamptz,
  ends_at               timestamptz,
  registration_open_at  timestamptz,
  registration_close_at timestamptz,
  location              text,
  registration_enabled  boolean,
  kit_enabled           boolean,
  is_active             boolean,
  participants_count    integer,
  created_at            timestamptz,
  updated_at            timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    e.id,
    e.name,
    e.slug,
    e.year,
    e.description,
    e.starts_at,
    e.ends_at,
    e.registration_open_at,
    e.registration_close_at,
    e.location,
    e.registration_enabled,
    e.kit_enabled,
    e.is_active,
    count(p.id)::integer as participants_count,
    e.created_at,
    e.updated_at
  from public.events e
  left join public.participants p
    on p.event_id = e.id
   and coalesce(p.registration_status, 'pending') <> 'cancelled'
  where
    -- Platform owner enxerga tudo
    public.is_platform_owner(auth.uid())
    or
    -- Membro ativo enxerga eventos da(s) própria(s) organização(ões)
    e.organization_id in (select public.user_organization_ids(auth.uid()))
  group by e.id
  order by e.year desc nulls last, e.created_at desc;
$$;

-- Mantém grant para authenticated; retira acesso anon (admin-only)
revoke all on function public.get_events_overview() from public, anon, authenticated;
grant execute on function public.get_events_overview() to authenticated;

-- ============================================================
-- 7. RLS em public.events
-- ============================================================

alter table public.events enable row level security;

-- SELECT público (site público e portal do participante)
create policy "events_select_public"
  on public.events for select
  to anon
  using (true);

-- SELECT para usuários autenticados: platform_user OU membro da org
create policy "events_select_authenticated"
  on public.events for select
  to authenticated
  using (
    public.is_platform_user(auth.uid())
    or public.is_organization_member(auth.uid(), organization_id)
  );

-- INSERT/UPDATE/DELETE são feitos via RPCs SECURITY DEFINER — sem políticas diretas.

commit;
