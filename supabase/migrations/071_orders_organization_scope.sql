-- 071_orders_organization_scope.sql
-- Adiciona organization_id em orders, sempre derivado do event_id.
-- Trigger garante consistência em todo INSERT/UPDATE futuro.

begin;

-- ============================================================
-- 1. COLUNA organization_id (nullable para permitir backfill)
-- ============================================================

alter table public.orders
  add column if not exists organization_id uuid
    references public.organizations(id);

-- ============================================================
-- 2. DIAGNÓSTICO
-- event_id já é NOT NULL em orders, então verificamos apenas:
--   - event_id que não existe em events;
--   - evento sem organization_id.
-- ============================================================

do $$
declare
  v_orphan_event  integer;
  v_event_no_org  integer;
begin
  select count(*) into v_orphan_event
  from public.orders o
  where not exists (
    select 1 from public.events e where e.id = o.event_id
  );

  select count(*) into v_event_no_org
  from public.orders o
  join public.events e on e.id = o.event_id
  where e.organization_id is null;

  if v_orphan_event > 0 or v_event_no_org > 0 then
    raise exception
      'Inconsistências em orders: % com event_id inexistente, % cujo evento não tem organization_id. Corrija antes de reaplicar.',
      v_orphan_event, v_event_no_org;
  end if;
end $$;

-- ============================================================
-- 3. BACKFILL
-- ============================================================

update public.orders o
set organization_id = e.organization_id
from public.events e
where e.id = o.event_id
  and o.organization_id is null;

-- ============================================================
-- 4. NOT NULL + ÍNDICES
-- ============================================================

alter table public.orders
  alter column organization_id set not null;

create index if not exists idx_orders_organization_id
  on public.orders(organization_id);

create index if not exists idx_orders_org_event
  on public.orders(organization_id, event_id);

create index if not exists idx_orders_org_created_at
  on public.orders(organization_id, created_at desc);

-- ============================================================
-- 5. TRIGGER DE CONSISTÊNCIA
-- BEFORE INSERT OR UPDATE: deriva organization_id do evento.
-- Rejeita event_id inválido e organization_id divergente do cliente.
-- ============================================================

create or replace function public.trg_orders_set_organization_id()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_event_org_id uuid;
begin
  if NEW.event_id is null then
    raise exception 'orders.event_id é obrigatório.';
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

  if NEW.organization_id is not null and NEW.organization_id <> v_event_org_id then
    raise exception
      'organization_id % diverge da organização do evento % (esperado: %).',
      NEW.organization_id, NEW.event_id, v_event_org_id;
  end if;

  NEW.organization_id := v_event_org_id;

  return NEW;
end;
$$;

drop trigger if exists trg_orders_org_consistency on public.orders;
create trigger trg_orders_org_consistency
  before insert or update on public.orders
  for each row execute function public.trg_orders_set_organization_id();

-- ============================================================
-- 6. RLS DE ORDERS — reconstrução com org-scoping
-- Política existente: orders_owner_select (comprador vê os próprios).
-- Novas políticas: acesso administrativo com permissão + org access.
-- Escrita continua via RPCs SECURITY DEFINER — sem policies de write.
-- ============================================================

-- Comprador vê os próprios pedidos (inalterado)
drop policy if exists "orders_owner_select" on public.orders;
create policy "orders_owner_select"
  on public.orders for select
  to authenticated
  using (auth.uid() = user_id);

-- Leitura administrativa com escopo de organização
drop policy if exists "orders_rbac_select" on public.orders;
create policy "orders_rbac_select"
  on public.orders for select
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'orders.view')
        or public.resolve_user_permission(auth.uid(), 'finance.view')
        or public.resolve_user_permission(auth.uid(), 'finance.view_amounts')
        or public.resolve_user_permission(auth.uid(), 'finance.confirm_payment')
        or public.resolve_user_permission(auth.uid(), 'finance.refund')
        or public.resolve_user_permission(auth.uid(), 'participants.view')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

-- ============================================================
-- 7. AUDITORIA DA MIGRATION
-- ============================================================

insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
select
  'orders_org_backfill',
  'orders',
  o.id,
  o.event_id,
  jsonb_build_object(
    'actor', 'system',
    'organization_id', o.organization_id,
    'order_id', o.id,
    'migration', '071_orders_organization_scope'
  )
from public.orders o
limit 1;

commit;
