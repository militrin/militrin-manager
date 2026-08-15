-- 072_tickets_organization_scope.sql
-- Adiciona organization_id em tickets, derivado do pedido (e validado contra o participante).
-- Atualiza RPCs de check-in para validar org access e corrige audit_logs sem coluna actor.

begin;

-- ============================================================
-- 1. COLUNA organization_id (nullable para backfill)
-- ============================================================

alter table public.tickets
  add column if not exists organization_id uuid
    references public.organizations(id);

-- ============================================================
-- 2. DIAGNÓSTICO
-- order_id é NOT NULL em tickets → base primária.
-- participant_id é nullable → verificar apenas quando existir.
-- ============================================================

do $$
declare
  v_orphan_order       integer;
  v_order_no_org       integer;
  v_orphan_participant integer;
  v_org_divergence     integer;
begin
  -- Pedidos referenciados que não existem (FK deveria garantir, mas validamos)
  select count(*) into v_orphan_order
  from public.tickets t
  where not exists (select 1 from public.orders o where o.id = t.order_id);

  -- Pedidos sem organization_id (migration 071 deve ter resolvido)
  select count(*) into v_order_no_org
  from public.tickets t
  join public.orders o on o.id = t.order_id
  where o.organization_id is null;

  -- Participantes referenciados que não existem
  select count(*) into v_orphan_participant
  from public.tickets t
  where t.participant_id is not null
    and not exists (select 1 from public.participants p where p.id = t.participant_id);

  -- Divergência de organização entre participante e pedido
  select count(*) into v_org_divergence
  from public.tickets t
  join public.orders o       on o.id = t.order_id
  join public.participants p on p.id = t.participant_id
  where t.participant_id is not null
    and p.organization_id is not null
    and o.organization_id is not null
    and p.organization_id <> o.organization_id;

  if v_orphan_order > 0 or v_order_no_org > 0 or v_orphan_participant > 0 or v_org_divergence > 0 then
    raise exception
      'Inconsistências em tickets: % order_id inexistente, % pedido sem org, % participant_id inexistente, % divergência participant/order. Corrija antes de reaplicar.',
      v_orphan_order, v_order_no_org, v_orphan_participant, v_org_divergence;
  end if;
end $$;

-- ============================================================
-- 3. BACKFILL — usa orders como fonte primária (sempre disponível)
-- ============================================================

update public.tickets t
set organization_id = o.organization_id
from public.orders o
where o.id = t.order_id
  and t.organization_id is null;

-- ============================================================
-- 4. NOT NULL + ÍNDICES
-- ============================================================

alter table public.tickets
  alter column organization_id set not null;

create index if not exists idx_tickets_organization_id
  on public.tickets(organization_id);

create index if not exists idx_tickets_org_status
  on public.tickets(organization_id, status);

create index if not exists idx_tickets_org_participant
  on public.tickets(organization_id, participant_id);

create index if not exists idx_tickets_org_order
  on public.tickets(organization_id, order_id);

-- ============================================================
-- 5. TRIGGER DE CONSISTÊNCIA
-- BEFORE INSERT OR UPDATE: resolve organization_id a partir de
-- orders (primário, sempre present) e valida contra participants.
-- ============================================================

create or replace function public.trg_tickets_set_organization_id()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order_org_id       uuid;
  v_participant_org_id uuid;
  v_resolved_org_id    uuid;
begin
  -- order_id é NOT NULL na tabela; resolve a org do pedido
  select organization_id into v_order_org_id
  from public.orders
  where id = NEW.order_id;

  if not found then
    raise exception 'Pedido % não encontrado em orders.', NEW.order_id;
  end if;

  if v_order_org_id is null then
    raise exception 'Pedido % não possui organization_id.', NEW.order_id;
  end if;

  -- Valida participante quando informado
  if NEW.participant_id is not null then
    select organization_id into v_participant_org_id
    from public.participants
    where id = NEW.participant_id;

    if not found then
      raise exception 'Participante % não encontrado em participants.', NEW.participant_id;
    end if;

    if v_participant_org_id is not null and v_participant_org_id <> v_order_org_id then
      raise exception
        'Divergência de organização: participante % (org %) e pedido % (org %) são de organizações diferentes.',
        NEW.participant_id, v_participant_org_id, NEW.order_id, v_order_org_id;
    end if;
  end if;

  v_resolved_org_id := v_order_org_id;

  -- Rejeita organization_id divergente vindo do cliente
  if NEW.organization_id is not null and NEW.organization_id <> v_resolved_org_id then
    raise exception
      'organization_id % diverge da organização resolvida % para o ticket.',
      NEW.organization_id, v_resolved_org_id;
  end if;

  NEW.organization_id := v_resolved_org_id;

  return NEW;
end;
$$;

drop trigger if exists trg_tickets_org_consistency on public.tickets;
create trigger trg_tickets_org_consistency
  before insert or update on public.tickets
  for each row execute function public.trg_tickets_set_organization_id();

-- ============================================================
-- 6. RPCs DE CHECK-IN ATUALIZADAS
-- Adiciona verificação de org access após encontrar o ticket.
-- Corrige audit_logs: remove coluna actor; actor_user_id/actor_email ficam em details.
-- ============================================================

create or replace function public.checkin_ticket_entry(p_ticket_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket      public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_payment     record;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
  v_used_at timestamptz := now();
begin
  if not public.current_user_has_permission('checkin.scan') then
    raise exception 'Sem permissao para realizar check-in.';
  end if;

  if p_ticket_id is null then
    raise exception 'Ingresso obrigatorio.';
  end if;

  select * into v_ticket
  from public.tickets
  where id = p_ticket_id
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  -- Verifica acesso à organização do ingresso
  if not public.user_can_access_organization(auth.uid(), v_ticket.organization_id) then
    raise exception 'Sem permissao para fazer check-in neste ingresso.';
  end if;

  if coalesce(v_ticket.status, 'pending') = 'cancelled' then
    raise exception 'Ingresso cancelado. Check-in bloqueado.';
  end if;

  if v_ticket.status = 'used' or v_ticket.used_at is not null then
    raise exception 'Este ingresso ja foi utilizado por outro operador.';
  end if;

  if v_ticket.participant_id is null then
    raise exception 'Ingresso sem titular definido.';
  end if;

  select * into v_participant
  from public.participants
  where id = v_ticket.participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select p.payment_status, p.payment_method
  into v_payment
  from public.get_participant_payment_details(v_participant.id) p
  limit 1;

  if coalesce(v_payment.payment_status, 'pending') <> 'paid' then
    raise exception 'Pagamento pendente. Check-in bloqueado.';
  end if;

  if coalesce(v_participant.registration_status, 'pending') = 'cancelled' then
    raise exception 'Inscricao cancelada. Check-in bloqueado.';
  end if;

  update public.tickets
  set status  = 'used',
      used_at = v_used_at
  where id = v_ticket.id;

  if v_participant.user_id is not null and v_participant.event_id is not null then
    insert into public.participation_history (
      event_id, user_id, participant_id, legacy_event_name, event_year,
      full_name, normalized_name, cpf, email, status, source,
      manually_verified, created_at, updated_at
    ) values (
      v_participant.event_id, v_participant.user_id, v_participant.id, null,
      extract(year from coalesce(v_participant.created_at, now()))::integer,
      coalesce(nullif(trim(v_participant.full_name), ''), 'Participante'),
      public.normalize_text_for_match(v_participant.full_name),
      v_participant.cpf, v_participant.email, 'confirmed', 'system',
      false, now(), now()
    )
    on conflict do nothing;

    perform public.recalculate_customer_loyalty(v_participant.user_id);
  end if;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'ticket_checkin_entry',
    'tickets',
    v_ticket.id,
    v_participant.event_id,
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'ticket_id', v_ticket.id,
      'participant_id', v_participant.id,
      'organization_id', v_ticket.organization_id,
      'used_at', v_used_at
    )
  );

  return true;
end;
$$;

create or replace function public.undo_ticket_checkin(p_ticket_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket      public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_actor_email text := coalesce(
    (select lower(u.email) from auth.users u where u.id = auth.uid()),
    'system'
  );
begin
  if not public.current_user_has_permission('checkin.undo') then
    raise exception 'Sem permissao para desfazer check-in.';
  end if;

  if p_ticket_id is null then
    raise exception 'Ingresso obrigatorio.';
  end if;

  select * into v_ticket
  from public.tickets
  where id = p_ticket_id
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  -- Verifica acesso à organização do ingresso
  if not public.user_can_access_organization(auth.uid(), v_ticket.organization_id) then
    raise exception 'Sem permissao para desfazer check-in neste ingresso.';
  end if;

  if v_ticket.status <> 'used' and v_ticket.used_at is null then
    raise exception 'Ingresso nao possui check-in para desfazer.';
  end if;

  if v_ticket.participant_id is not null then
    select * into v_participant
    from public.participants
    where id = v_ticket.participant_id;
  end if;

  update public.tickets
  set status  = 'active',
      used_at = null
  where id = v_ticket.id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (
    'ticket_checkin_undo',
    'tickets',
    v_ticket.id,
    coalesce(v_participant.event_id, v_ticket.event_id),
    jsonb_build_object(
      'actor_user_id', auth.uid(),
      'actor_email', v_actor_email,
      'ticket_id', v_ticket.id,
      'participant_id', v_ticket.participant_id,
      'organization_id', v_ticket.organization_id
    )
  );

  return true;
end;
$$;

grant execute on function public.checkin_ticket_entry(uuid) to authenticated;
grant execute on function public.undo_ticket_checkin(uuid) to authenticated;

-- ============================================================
-- 7. RLS DE TICKETS — reconstrução com org-scoping
-- Mantém tickets_owner_select (comprador via order join).
-- Adiciona tickets_rbac_select para acesso administrativo.
-- ============================================================

-- Comprador vê os próprios ingressos via pedido (inalterado)
drop policy if exists "tickets_owner_select" on public.tickets;
create policy "tickets_owner_select"
  on public.tickets for select
  to authenticated
  using (
    exists (
      select 1
      from public.orders o
      where o.id = tickets.order_id
        and o.user_id = auth.uid()
    )
  );

-- Leitura administrativa: platform owner vê tudo; demais exigem org access
drop policy if exists "tickets_rbac_select" on public.tickets;
create policy "tickets_rbac_select"
  on public.tickets for select
  to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or (
      (
        public.is_active_owner(auth.uid())
        or public.resolve_user_permission(auth.uid(), 'orders.view')
        or public.resolve_user_permission(auth.uid(), 'participants.view')
        or public.resolve_user_permission(auth.uid(), 'checkin.view')
        or public.resolve_user_permission(auth.uid(), 'checkin.scan')
        or public.resolve_user_permission(auth.uid(), 'checkin.undo')
        or public.resolve_user_permission(auth.uid(), 'kits.view')
        or public.resolve_user_permission(auth.uid(), 'kits.deliver')
      )
      and public.user_can_access_organization(auth.uid(), organization_id)
    )
  );

-- ============================================================
-- 8. AUDITORIA DA MIGRATION
-- ============================================================

insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
select
  'tickets_org_backfill',
  'tickets',
  t.id,
  t.event_id,
  jsonb_build_object(
    'actor', 'system',
    'organization_id', t.organization_id,
    'ticket_id', t.id,
    'participant_id', t.participant_id,
    'order_id', t.order_id,
    'migration', '072_tickets_organization_scope'
  )
from public.tickets t
limit 1;

commit;
