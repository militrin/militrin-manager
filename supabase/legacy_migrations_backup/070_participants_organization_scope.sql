-- 070_participants_organization_scope.sql
-- Adiciona organization_id em participants, sempre derivado do event_id.
-- Trigger garante consistência em todo INSERT/UPDATE futuro.

begin;

-- ============================================================
-- 1. COLUNA organization_id (nullable inicialmente para permitir backfill)
-- ============================================================

alter table public.participants
  add column if not exists organization_id uuid
    references public.organizations(id);

-- ============================================================
-- 2. DIAGNÓSTICO ANTES DO BACKFILL
-- Levanta inconsistências e interrompe a migration se existirem.
-- ============================================================

do $$
declare
  v_no_event_id      integer;
  v_orphan_event_id  integer;
  v_event_no_org     integer;
begin
  select count(*) into v_no_event_id
  from public.participants
  where event_id is null;

  select count(*) into v_orphan_event_id
  from public.participants p
  where p.event_id is not null
    and not exists (
      select 1 from public.events e where e.id = p.event_id
    );

  select count(*) into v_event_no_org
  from public.participants p
  join public.events e on e.id = p.event_id
  where e.organization_id is null;

  if v_no_event_id > 0 or v_orphan_event_id > 0 or v_event_no_org > 0 then
    raise exception
      'Inconsistências encontradas em participants: % sem event_id, % com event_id inexistente, % cujo evento não tem organization_id. Corrija os dados antes de reaplicar.',
      v_no_event_id, v_orphan_event_id, v_event_no_org;
  end if;
end $$;

-- ============================================================
-- 3. BACKFILL — apenas registros consistentes
-- ============================================================

update public.participants p
set organization_id = e.organization_id
from public.events e
where e.id = p.event_id
  and p.organization_id is null;

-- ============================================================
-- 4. NOT NULL + ÍNDICES
-- ============================================================

alter table public.participants
  alter column organization_id set not null;

create index if not exists idx_participants_organization_id
  on public.participants(organization_id);

create index if not exists idx_participants_org_event
  on public.participants(organization_id, event_id);

-- ============================================================
-- 5. TRIGGER DE CONSISTÊNCIA
-- BEFORE INSERT OR UPDATE:
--   - exige event_id;
--   - resolve organization_id a partir do evento;
--   - rejeita organization_id divergente enviado pelo cliente;
--   - ao alterar event_id, atualiza organization_id.
-- Nota: RLS WITH CHECK é avaliado antes do trigger; o NOT NULL só
-- é verificado depois do trigger — por isso o trigger consegue preencher
-- organization_id antes da checagem da constraint.
-- ============================================================

create or replace function public.trg_participants_set_organization_id()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_event_org_id uuid;
begin
  if NEW.event_id is null then
    raise exception 'participants.event_id é obrigatório.';
  end if;

  select organization_id into v_event_org_id
  from public.events
  where id = NEW.event_id;

  if not found then
    raise exception 'Evento % não encontrado em events.', NEW.event_id;
  end if;

  if v_event_org_id is null then
    raise exception 'Evento % não possui organization_id.', NEW.event_id;
  end if;

  -- Rejeita organization_id divergente vindo do cliente
  if NEW.organization_id is not null and NEW.organization_id <> v_event_org_id then
    raise exception
      'organization_id % diverge da organização do evento % (esperado: %).',
      NEW.organization_id, NEW.event_id, v_event_org_id;
  end if;

  -- Garante que organization_id sempre reflete o evento
  NEW.organization_id := v_event_org_id;

  return NEW;
end;
$$;

drop trigger if exists trg_participants_org_consistency on public.participants;
create trigger trg_participants_org_consistency
  before insert or update on public.participants
  for each row execute function public.trg_participants_set_organization_id();

-- ============================================================
-- 6. HELPER: user_can_access_organization
-- Platform owner/admin ativo → true.
-- Membro ativo da organização → true.
-- Demais → false.
-- ============================================================

create or replace function public.user_can_access_organization(
  p_user_id       uuid,
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    -- Platform owner e admin têm acesso a todas as organizações
    exists (
      select 1
      from public.platform_users pu
      where pu.user_id  = p_user_id
        and pu.is_active = true
        and pu.role in ('owner', 'admin')
    )
    or
    -- Membro ativo da organização específica
    exists (
      select 1
      from public.organization_members om
      where om.user_id         = p_user_id
        and om.organization_id = p_organization_id
        and om.is_active = true
    );
$$;

grant execute on function public.user_can_access_organization(uuid, uuid) to authenticated;

-- ============================================================
-- 7. RLS DE PARTICIPANTS — reconstrução com org-scoping
-- Regras de 059 preservadas; acesso RBAC agora exige também
-- pertencimento à organização do participante.
-- Platform owner continua vendo tudo.
-- Auto-acesso do participante (user_id = auth.uid()) inalterado.
-- ============================================================

-- Participante vê o próprio registro — sem org-scoping
drop policy if exists participants_owner_select on public.participants;
create policy participants_owner_select
  on public.participants for select
  to authenticated
  using (auth.uid() = user_id);

-- Participante atualiza o próprio registro — sem org-scoping
drop policy if exists participants_owner_update on public.participants;
create policy participants_owner_update
  on public.participants for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- SELECT administrativo: platform owner vê tudo; demais exigem org access
drop policy if exists participants_rbac_select on public.participants;
create policy participants_rbac_select
  on public.participants for select
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'participants.view')
        or public.resolve_user_permission(auth.uid(), 'kits.view')
        or public.resolve_user_permission(auth.uid(), 'checkin.view')
        or public.resolve_user_permission(auth.uid(), 'checkin.scan')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

-- INSERT: verifica RBAC + acesso à org do evento (event_id vem do cliente;
-- organization_id ainda não está definido quando RLS WITH CHECK avalia).
-- Na prática todos os inserts passam por RPCs SECURITY DEFINER,
-- portanto esta policy atua como camada adicional de defesa.
drop policy if exists participants_rbac_insert on public.participants;
create policy participants_rbac_insert
  on public.participants for insert
  to authenticated
  with check (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'participants.create')
        or public.resolve_user_permission(auth.uid(), 'imports.create')
      )
      and (
        -- event_id nulo: trigger rejeitará; deixa passar para o trigger lidar
        event_id is null
        or public.user_can_access_organization(
          auth.uid(),
          (select e.organization_id from public.events e where e.id = event_id)
        )
      )
    )
  );

-- UPDATE administrativo: mesmas permissões de 059 + org access
drop policy if exists participants_rbac_update on public.participants;
create policy participants_rbac_update
  on public.participants for update
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'participants.edit_basic')
        or public.resolve_user_permission(auth.uid(), 'participants.edit_sensitive')
        or public.resolve_user_permission(auth.uid(), 'participants.cancel')
        or public.resolve_user_permission(auth.uid(), 'inventory.change_participant_shirt')
        or public.resolve_user_permission(auth.uid(), 'kits.deliver')
        or public.resolve_user_permission(auth.uid(), 'kits.undo_delivery')
        or public.resolve_user_permission(auth.uid(), 'checkin.scan')
        or public.resolve_user_permission(auth.uid(), 'checkin.undo')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  )
  with check (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'participants.edit_basic')
        or public.resolve_user_permission(auth.uid(), 'participants.edit_sensitive')
        or public.resolve_user_permission(auth.uid(), 'participants.cancel')
        or public.resolve_user_permission(auth.uid(), 'inventory.change_participant_shirt')
        or public.resolve_user_permission(auth.uid(), 'kits.deliver')
        or public.resolve_user_permission(auth.uid(), 'kits.undo_delivery')
        or public.resolve_user_permission(auth.uid(), 'checkin.scan')
        or public.resolve_user_permission(auth.uid(), 'checkin.undo')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

-- DELETE físico restrito ao Owner — sem org-scoping adicional (is_active_owner já é bastante restritivo)
drop policy if exists participants_owner_delete on public.participants;
create policy participants_owner_delete
  on public.participants for delete
  to authenticated
  using (public.is_active_owner(auth.uid()));

-- ============================================================
-- 8. AUDITORIA DA MIGRATION
-- ============================================================

insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
select
  'participants_org_backfill',
  'participants',
  p.id,
  p.event_id,
  jsonb_build_object(
    'actor', 'system',
    'organization_id', p.organization_id,
    'migration', '070_participants_organization_scope'
  )
from public.participants p
limit 1;  -- registra uma linha de prova da migration; contagem real está no diagnóstico acima

commit;
