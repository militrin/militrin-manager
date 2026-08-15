-- 073_payments_organization_scope.sql
-- Adiciona organization_id em payments, derivado de order_id > event_id > participant_id.
-- Tabelas financeiras inventariadas: apenas public.payments é transacional.
-- event_payment_methods é configuração por evento — sem organization_id necessário.

begin;

-- ============================================================
-- 1. COLUNA organization_id (nullable para backfill)
-- ============================================================

alter table public.payments
  add column if not exists organization_id uuid
    references public.organizations(id);

-- ============================================================
-- 2. DIAGNÓSTICO
-- Prioridade de resolução: order_id → event_id → participant_id.
-- Verifica divergências cruzadas antes do backfill.
-- ============================================================

do $$
declare
  v_no_path         integer;
  v_orphan_order    integer;
  v_orphan_event    integer;
  v_orphan_part     integer;
  v_divergence      integer;
begin
  -- Payments sem nenhum caminho de resolução
  select count(*) into v_no_path
  from public.payments py
  where py.order_id is null
    and py.event_id is null
    and py.participant_id is null;

  -- order_id referenciando pedido inexistente
  select count(*) into v_orphan_order
  from public.payments py
  where py.order_id is not null
    and not exists (select 1 from public.orders o where o.id = py.order_id);

  -- event_id referenciando evento inexistente (sem order_id)
  select count(*) into v_orphan_event
  from public.payments py
  where py.order_id is null
    and py.event_id is not null
    and not exists (select 1 from public.events e where e.id = py.event_id);

  -- participant_id referenciando participante inexistente (sem order_id nem event_id)
  select count(*) into v_orphan_part
  from public.payments py
  where py.order_id is null
    and py.event_id is null
    and not exists (select 1 from public.participants p where p.id = py.participant_id);

  -- Divergência entre organization_id de order e event (quando ambos existem)
  select count(*) into v_divergence
  from public.payments py
  join public.orders o   on o.id  = py.order_id
  join public.events e   on e.id  = py.event_id
  where py.order_id  is not null
    and py.event_id  is not null
    and o.organization_id is not null
    and e.organization_id is not null
    and o.organization_id <> e.organization_id;

  if v_no_path > 0 or v_orphan_order > 0 or v_orphan_event > 0
     or v_orphan_part > 0 or v_divergence > 0 then
    raise exception
      'Inconsistências em payments: % sem caminho, % order inexistente, % event inexistente, % participant inexistente, % divergência order/event. Corrija antes de reaplicar.',
      v_no_path, v_orphan_order, v_orphan_event, v_orphan_part, v_divergence;
  end if;
end $$;

-- ============================================================
-- 3. BACKFILL
-- Prioridade: order_id → event_id → participant_id.
-- ============================================================

-- 3a. Via order_id (mais específico; cobre a maioria dos registros modernos)
update public.payments py
set organization_id = o.organization_id
from public.orders o
where o.id = py.order_id
  and py.organization_id is null;

-- 3b. Via event_id (pagamentos legados anteriores à coluna order_id)
update public.payments py
set organization_id = e.organization_id
from public.events e
where e.id = py.event_id
  and py.organization_id is null;

-- 3c. Via participant_id (último fallback para pagamentos muito antigos)
update public.payments py
set organization_id = p.organization_id
from public.participants p
where p.id = py.participant_id
  and py.organization_id is null;

-- ============================================================
-- 4. NOT NULL + ÍNDICES
-- ============================================================

alter table public.payments
  alter column organization_id set not null;

create index if not exists idx_payments_organization_id
  on public.payments(organization_id);

create index if not exists idx_payments_org_status
  on public.payments(organization_id, payment_status);

create index if not exists idx_payments_org_event
  on public.payments(organization_id, event_id);

create index if not exists idx_payments_org_created_at
  on public.payments(organization_id, created_at desc);

-- ============================================================
-- 5. TRIGGER DE CONSISTÊNCIA
-- BEFORE INSERT OR UPDATE: resolve e valida organization_id.
-- Prioridade: order_id → event_id → participant_id.
-- Divergência entre fontes gera exceção.
-- ============================================================

create or replace function public.trg_payments_set_organization_id()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order_org_id       uuid;
  v_event_org_id       uuid;
  v_participant_org_id uuid;
  v_resolved_org_id    uuid;
begin
  -- Resolve por order_id
  if NEW.order_id is not null then
    select organization_id into v_order_org_id
    from public.orders where id = NEW.order_id;

    if not found then
      raise exception 'Pedido % não encontrado em orders.', NEW.order_id;
    end if;
  end if;

  -- Resolve por event_id
  if NEW.event_id is not null then
    select organization_id into v_event_org_id
    from public.events where id = NEW.event_id;

    if not found then
      raise exception 'Evento % não encontrado em events.', NEW.event_id;
    end if;
  end if;

  -- Resolve por participant_id
  if NEW.participant_id is not null then
    select organization_id into v_participant_org_id
    from public.participants where id = NEW.participant_id;

    if not found then
      raise exception 'Participante % não encontrado em participants.', NEW.participant_id;
    end if;
  end if;

  -- Verifica divergência entre order e event
  if v_order_org_id is not null and v_event_org_id is not null
     and v_order_org_id <> v_event_org_id then
    raise exception
      'Divergência: pedido (org %) e evento (org %) apontam para organizações diferentes no pagamento.',
      v_order_org_id, v_event_org_id;
  end if;

  -- Verifica divergência entre order/event e participant
  if v_participant_org_id is not null then
    if v_order_org_id is not null and v_order_org_id <> v_participant_org_id then
      raise exception
        'Divergência: pedido (org %) e participante (org %) apontam para organizações diferentes.',
        v_order_org_id, v_participant_org_id;
    end if;
    if v_event_org_id is not null and v_event_org_id <> v_participant_org_id then
      raise exception
        'Divergência: evento (org %) e participante (org %) apontam para organizações diferentes.',
        v_event_org_id, v_participant_org_id;
    end if;
  end if;

  -- Usa prioridade: order_id > event_id > participant_id
  v_resolved_org_id := coalesce(v_order_org_id, v_event_org_id, v_participant_org_id);

  if v_resolved_org_id is null then
    raise exception
      'Não foi possível determinar a organização para o pagamento (order_id=%, event_id=%, participant_id=%).',
      NEW.order_id, NEW.event_id, NEW.participant_id;
  end if;

  -- Rejeita organization_id divergente enviado pelo cliente
  if NEW.organization_id is not null and NEW.organization_id <> v_resolved_org_id then
    raise exception
      'organization_id % diverge da organização resolvida % para o pagamento.',
      NEW.organization_id, v_resolved_org_id;
  end if;

  NEW.organization_id := v_resolved_org_id;

  return NEW;
end;
$$;

drop trigger if exists trg_payments_org_consistency on public.payments;
create trigger trg_payments_org_consistency
  before insert or update on public.payments
  for each row execute function public.trg_payments_set_organization_id();

-- ============================================================
-- 6. RLS DE PAYMENTS — reconstrução com org-scoping
-- payments_owner_select preservada (participante vê os próprios).
-- payments_rbac_select adicionada para acesso administrativo.
-- Sem policies de write — todos os writes via RPCs SECURITY DEFINER.
-- NOTA: payments_rbac_select também corrige o acesso do painel
-- financeiro que só funcionava para admins que eram participantes.
-- ============================================================

-- Participante/comprador vê os próprios pagamentos (inalterado)
drop policy if exists "payments_owner_select" on public.payments;
create policy "payments_owner_select"
  on public.payments for select
  to authenticated
  using (
    exists (
      select 1
      from public.participants p
      where p.id = payments.participant_id
        and p.user_id = auth.uid()
    )
  );

-- Leitura administrativa com escopo de organização
drop policy if exists "payments_rbac_select" on public.payments;
create policy "payments_rbac_select"
  on public.payments for select
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'finance.view')
        or public.resolve_user_permission(auth.uid(), 'finance.view_amounts')
        or public.resolve_user_permission(auth.uid(), 'finance.confirm_payment')
        or public.resolve_user_permission(auth.uid(), 'finance.refund')
        or public.resolve_user_permission(auth.uid(), 'finance.export')
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
  'payments_org_backfill',
  'payments',
  py.id,
  py.event_id,
  jsonb_build_object(
    'actor', 'system',
    'organization_id', py.organization_id,
    'payment_id', py.id,
    'order_id', py.order_id,
    'migration', '073_payments_organization_scope'
  )
from public.payments py
limit 1;

commit;
