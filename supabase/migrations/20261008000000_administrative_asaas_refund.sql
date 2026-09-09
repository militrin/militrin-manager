-- Estorno administrativo Asaas (FULL, iniciado pelo Militrin).
--
-- Regras:
-- - ESTORNAR PAGAMENTO nao e CANCELAR INGRESSO.
-- - payment_status permanece 'paid' ate o gateway confirmar o estorno.
-- - refund_status acompanha a tentativa (requested/pending/uncertain/failed/completed).
-- - Ticket so e cancelado se a tentativa pediu cancel_tickets explicitamente.
-- - Timeout nao e falha definitiva: fica 'uncertain' e exige conciliacao.
-- - Schema futuro (NAO criado agora): refunded_amount, remaining_amount.
--   Partial externo (PAYMENT_PARTIALLY_REFUNDED) continua mapeando para
--   payment_status='refunded' nesta fase, sem UI de estorno parcial.
begin;

-- ---------------------------------------------------------------------------
-- 1) Colunas e historico
-- ---------------------------------------------------------------------------
alter table public.payments
  add column if not exists refund_status text;

alter table public.payments
  drop constraint if exists payments_refund_status_check;
alter table public.payments
  add constraint payments_refund_status_check
  check (refund_status is null or refund_status in ('requested', 'pending', 'completed', 'failed', 'uncertain'));

comment on column public.payments.refund_status is
  'Estado da tentativa de estorno administrativo: requested|pending|uncertain|failed|completed. Nao substitui payment_status. paid+requested continua em Receita Confirmada ate o gateway confirmar.';

create table if not exists public.payment_refund_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  order_id uuid references public.orders(id) on delete set null,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  event_id uuid references public.events(id) on delete set null,
  requested_by uuid references auth.users(id) on delete set null,
  reason_code text not null,
  reason_text text,
  cancel_tickets boolean not null default false,
  amount numeric not null,
  environment text,
  account_key text,
  gateway_payment_id text,
  status text not null,
  gateway_response jsonb not null default '{}'::jsonb,
  failure_text text,
  ticket_ids uuid[] not null default '{}',
  ticket_results jsonb not null default '[]'::jsonb,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_refund_attempts_status_check
    check (status in ('requested', 'pending', 'completed', 'failed', 'uncertain')),
  constraint payment_refund_attempts_reason_check
    check (reason_code in (
      'customer_request',
      'duplicate_purchase',
      'operational_error',
      'event_category_changed',
      'administrative_test',
      'other'
    )),
  constraint payment_refund_attempts_environment_check
    check (environment is null or environment in ('sandbox', 'production')),
  constraint payment_refund_attempts_amount_check
    check (amount > 0)
);

create unique index if not exists ux_payment_refund_attempts_open
  on public.payment_refund_attempts (payment_id)
  where status in ('requested', 'pending', 'uncertain');

create index if not exists idx_payment_refund_attempts_payment
  on public.payment_refund_attempts (payment_id, requested_at desc);

comment on table public.payment_refund_attempts is
  'Historico de estorno administrativo. Sem secrets. Uma tentativa aberta por pagamento (requested/pending/uncertain).';

alter table public.payment_refund_attempts enable row level security;

drop policy if exists "payment_refund_attempts_select_finance" on public.payment_refund_attempts;
create policy "payment_refund_attempts_select_finance"
  on public.payment_refund_attempts
  for select
  to authenticated
  using (
    public.user_can_access_organization(auth.uid(), organization_id)
    and (
      public.is_active_owner(auth.uid())
      or public.resolve_user_permission(auth.uid(), 'finance.view')
      or public.resolve_user_permission(auth.uid(), 'finance.refund')
    )
  );

grant select on public.payment_refund_attempts to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Notificacoes
-- ---------------------------------------------------------------------------
alter table public.organization_notifications
  drop constraint if exists organization_notifications_type_check;
alter table public.organization_notifications
  add constraint organization_notifications_type_check
  check (type in (
    'CHANGE_REQUEST_CREATED',
    'FEEDBACK_CREATED',
    'PAYMENT_REFUNDED',
    'PAYMENT_REFUND_FAILED'
  ));

create or replace function public.user_can_view_organization_notification(p_user_id uuid, p_notification public.organization_notifications)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
    and public.user_can_access_organization(p_user_id, p_notification.organization_id)
    and case p_notification.type
      when 'CHANGE_REQUEST_CREATED' then public.user_has_permission(p_user_id, 'kits.deliver')
      when 'FEEDBACK_CREATED' then public.user_has_permission(p_user_id, 'feedback.view')
      when 'PAYMENT_REFUNDED' then (
        public.user_has_permission(p_user_id, 'finance.view')
        or public.user_has_permission(p_user_id, 'finance.refund')
      )
      when 'PAYMENT_REFUND_FAILED' then (
        public.user_has_permission(p_user_id, 'finance.view')
        or public.user_has_permission(p_user_id, 'finance.refund')
      )
      else false
    end;
$$;

create or replace function public.list_organization_notifications(
  p_read_state text default 'all',
  p_type text default null,
  p_limit integer default 20,
  p_offset integer default 0
) returns table(
  notification_id uuid,
  type text,
  title text,
  body text,
  action_href text,
  entity_type text,
  entity_id uuid,
  event_id uuid,
  created_at timestamptz,
  read_at timestamptz,
  is_unread boolean,
  total_count integer
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid;
  v_state text := lower(trim(coalesce(p_read_state, 'all')));
  v_type text := nullif(upper(trim(coalesce(p_type, ''))), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  v_org := public.current_organization_id();
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;
  if v_state not in ('all', 'unread', 'read') then
    raise exception 'Filtro de leitura invalido.';
  end if;
  if v_type is not null and v_type not in (
    'CHANGE_REQUEST_CREATED',
    'FEEDBACK_CREATED',
    'PAYMENT_REFUNDED',
    'PAYMENT_REFUND_FAILED'
  ) then
    raise exception 'Tipo de notificacao invalido.';
  end if;

  return query
  with visible as (
    select n.*, r.read_at as user_read_at
    from public.organization_notifications n
    left join public.organization_notification_reads r
      on r.notification_id = n.id and r.user_id = v_actor
    where n.organization_id = v_org
      and public.user_can_view_organization_notification(v_actor, n)
      and (v_type is null or n.type = v_type)
      and (
        v_state = 'all'
        or (v_state = 'unread' and r.read_at is null)
        or (v_state = 'read' and r.read_at is not null)
      )
  )
  select
    v.id, v.type, v.title, v.body, v.action_href, v.entity_type, v.entity_id, v.event_id, v.created_at,
    v.user_read_at, (v.user_read_at is null), (count(*) over ())::integer
  from visible v
  order by v.created_at desc, v.id desc
  limit v_limit offset v_offset;
end; $$;

-- ---------------------------------------------------------------------------
-- 3) Estorno de pagamento NAO cancela ingresso/produto automaticamente
-- ---------------------------------------------------------------------------
create or replace function public._apply_terminal_order_payment_status(p_payment_id uuid, p_target_status text)
returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_payment public.payments%rowtype;
  v_line record;
  v_remaining_paid integer;
begin
  if p_target_status not in ('expired','cancelled','refunded') then
    raise exception 'Status terminal invalido: %', p_target_status;
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then return; end if;

  update public.payments set
    payment_status = p_target_status,
    refunded_at = case when p_target_status = 'refunded' then coalesce(refunded_at, now()) else refunded_at end,
    refund_status = case when p_target_status = 'refunded' then 'completed' else refund_status end,
    expires_at = case when p_target_status in ('expired','cancelled') then null else expires_at end,
    updated_at = now()
  where id = p_payment_id;

  if v_payment.order_id is null then
    return;
  end if;

  if p_target_status = 'refunded' then
    -- Multi-payment: so marca o pedido refunded se nao restar outro paid.
    select count(*)::integer into v_remaining_paid
    from public.payments
    where order_id = v_payment.order_id
      and id <> v_payment.id
      and payment_status = 'paid';

    if coalesce(v_remaining_paid, 0) = 0 then
      update public.orders set status = 'refunded' where id = v_payment.order_id;
    end if;
  else
    for v_line in
      update public.order_items set status = p_target_status, reservation_expires_at = null, updated_at = now()
      where order_id = v_payment.order_id and status = 'reserved'
      returning id, item_kind, store_item_id, store_item_variant_id, quantity
    loop
      if v_line.item_kind = 'product' then
        perform public.release_store_item_reservation(v_line.store_item_id, v_line.store_item_variant_id, v_line.quantity);
        update public.order_item_pickup_units set status = 'cancelled', updated_at = now()
        where order_item_id = v_line.id and status <> 'delivered';
      end if;
    end loop;

    update public.orders set status = p_target_status where id = v_payment.order_id and status = 'pending';

    if p_target_status = 'expired' then
      update public.participants pt
      set reservation_status = 'expired',
          registration_status = 'cancelled',
          reservation_released_at = now()
      where pt.reservation_status = 'pending'
        and pt.id in (
          select oi.participant_id
          from public.order_items oi
          where oi.order_id = v_payment.order_id
            and oi.participant_id is not null
            and oi.status = 'expired'
        );
    end if;
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('payment_'||p_target_status, 'payments', p_payment_id, v_payment.event_id,
    jsonb_build_object('order_id', v_payment.order_id, 'provider', v_payment.provider, 'organization_id', v_payment.organization_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Cancelamento opcional de entitlements (ticket + produto nao entregue)
-- ---------------------------------------------------------------------------
create or replace function public.apply_refund_linked_entitlement_cancellations(p_attempt_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt public.payment_refund_attempts%rowtype;
  v_payment public.payments%rowtype;
  v_ticket public.tickets%rowtype;
  v_link record;
  v_line record;
  v_results jsonb := '[]'::jsonb;
  v_reason_text text;
  v_skip_reason text;
begin
  select * into v_attempt from public.payment_refund_attempts where id = p_attempt_id for update;
  if not found then
    raise exception 'Tentativa de estorno nao encontrada.';
  end if;
  if not v_attempt.cancel_tickets then
    return jsonb_build_object('success', true, 'skipped', true, 'results', v_results);
  end if;

  select * into v_payment from public.payments where id = v_attempt.payment_id for update;
  if not found then
    raise exception 'Pagamento nao encontrado.';
  end if;
  if v_payment.order_id is null then
    return jsonb_build_object('success', true, 'skipped', true, 'reason', 'no_order', 'results', v_results);
  end if;

  v_reason_text := coalesce(nullif(trim(v_attempt.reason_text), ''), v_attempt.reason_code);

  for v_ticket in
    select * from public.tickets
    where order_id = v_payment.order_id
    order by id
    for update
  loop
    if v_ticket.status = 'cancelled' then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'ticket_id', v_ticket.id, 'outcome', 'already_cancelled'
      ));
      continue;
    end if;

    v_skip_reason := null;
    if v_ticket.status = 'used' or v_ticket.used_at is not null then
      v_skip_reason := 'used';
    elsif exists (
      select 1 from public.participant_kit_items kit_link
      where kit_link.ticket_id = v_ticket.id and kit_link.status = 'delivered'
    ) then
      v_skip_reason := 'kit_delivered';
    end if;

    if v_skip_reason is not null then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'ticket_id', v_ticket.id, 'outcome', 'blocked', 'reason', v_skip_reason
      ));
      continue;
    end if;

    for v_link in
      select kit_link.id from public.participant_kit_items as kit_link
      where kit_link.ticket_id = v_ticket.id and kit_link.status <> 'cancelled'
      order by kit_link.id
      for update
    loop
      update public.participant_kit_items as kit_link set status = 'cancelled' where kit_link.id = v_link.id;
    end loop;

    update public.tickets as ticket set
      status = 'cancelled',
      cancelled_at = coalesce(ticket.cancelled_at, now()),
      cancellation_reason_code = v_attempt.reason_code,
      cancellation_reason_text = v_reason_text,
      cancellation_replacement_required = false
    where ticket.id = v_ticket.id;

    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'admin_ticket_cancelled',
      'tickets',
      v_ticket.id,
      v_ticket.event_id,
      jsonb_build_object(
        'actor_user_id', v_attempt.requested_by,
        'reason_code', v_attempt.reason_code,
        'reason_text', v_reason_text,
        'replacement_required', false,
        'source', 'admin_payment_refund',
        'payment_id', v_payment.id,
        'attempt_id', v_attempt.id
      )
    );

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'ticket_id', v_ticket.id, 'outcome', 'cancelled'
    ));
  end loop;

  for v_line in
    update public.order_items set status = 'refunded', reservation_expires_at = null, updated_at = now()
    where order_id = v_payment.order_id
      and item_kind = 'product'
      and status not in ('cancelled', 'expired', 'refunded', 'transferred', 'delivered')
      and not exists (
        select 1 from public.order_item_pickup_units u
        where u.order_item_id = order_items.id and u.status = 'delivered'
      )
    returning id, store_item_id, store_item_variant_id, quantity
  loop
    perform public.release_store_item_reservation(v_line.store_item_id, v_line.store_item_variant_id, v_line.quantity);
    update public.order_item_pickup_units set status = 'cancelled', updated_at = now()
    where order_item_id = v_line.id and status <> 'delivered';
  end loop;

  update public.payment_refund_attempts
  set ticket_results = v_results,
      ticket_ids = coalesce((
        select array_agg((item->>'ticket_id')::uuid)
        from jsonb_array_elements(v_results) item
        where item->>'outcome' = 'cancelled'
      ), '{}'),
      updated_at = now()
  where id = v_attempt.id;

  return jsonb_build_object('success', true, 'skipped', false, 'results', v_results);
end;
$$;

revoke all on function public.apply_refund_linked_entitlement_cancellations(uuid) from public, anon, authenticated;
grant execute on function public.apply_refund_linked_entitlement_cancellations(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5) RPCs de tentativa
-- ---------------------------------------------------------------------------
create or replace function public.begin_admin_payment_refund(
  p_payment_id uuid,
  p_reason_code text,
  p_reason_text text default null,
  p_cancel_tickets boolean default false
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_payment public.payments%rowtype;
  v_attempt public.payment_refund_attempts%rowtype;
  v_reason_text text := nullif(trim(coalesce(p_reason_text, '')), '');
  v_amount numeric;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Pagamento nao encontrado.'; end if;

  if not (
    public.user_can_access_organization(v_actor, v_payment.organization_id)
    and (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor, 'finance.refund'))
  ) then
    raise exception 'Sem permissao para estornar pagamento.';
  end if;

  if nullif(trim(coalesce(p_reason_code, '')), '') is null
    or p_reason_code not in (
      'customer_request', 'duplicate_purchase', 'operational_error',
      'event_category_changed', 'administrative_test', 'other'
    )
  then
    raise exception 'Motivo obrigatorio.';
  end if;
  if p_reason_code = 'other' and v_reason_text is null then
    raise exception 'Descreva o motivo do estorno.';
  end if;

  if v_payment.payment_status = 'refunded' or v_payment.refund_status = 'completed' then
    return jsonb_build_object(
      'success', true, 'already_completed', true, 'payment_id', v_payment.id,
      'refund_status', coalesce(v_payment.refund_status, 'completed')
    );
  end if;

  select * into v_attempt
  from public.payment_refund_attempts
  where payment_id = v_payment.id
    and status in ('requested', 'pending', 'uncertain')
  order by requested_at desc
  limit 1;

  if found then
    return jsonb_build_object(
      'success', true,
      'already_open', true,
      'attempt_id', v_attempt.id,
      'payment_id', v_payment.id,
      'refund_status', v_payment.refund_status,
      'attempt_status', v_attempt.status,
      'cancel_tickets', v_attempt.cancel_tickets,
      'gateway_payment_id', v_attempt.gateway_payment_id,
      'account_key', v_attempt.account_key,
      'organization_id', v_payment.organization_id,
      'amount', v_attempt.amount
    );
  end if;

  if v_payment.payment_method = 'courtesy' then raise exception 'Cortesia nao pode ser estornada no Asaas.'; end if;
  if v_payment.price_origin = 'legacy_unknown' then raise exception 'Pagamento com preco historico nao informado nao pode ser estornado no Asaas.'; end if;
  if lower(coalesce(v_payment.provider, '')) <> 'asaas' then raise exception 'Estorno administrativo so esta disponivel para pagamentos Asaas.'; end if;
  if lower(coalesce(v_payment.provider, '')) = 'fake'
    or lower(coalesce(v_payment.gateway_payment_id, '')) like 'fake_%' then
    raise exception 'Pagamento sintetico/fake nao pode ser estornado no Asaas.';
  end if;
  if nullif(trim(coalesce(v_payment.gateway_payment_id, '')), '') is null then
    raise exception 'Este pagamento nao tem identificador de cobranca no gateway.';
  end if;
  if nullif(trim(coalesce(v_payment.gateway_account_key, '')), '') is null then
    raise exception 'A conta Asaas original desta cobranca nao esta configurada.';
  end if;
  if coalesce(v_payment.gateway_environment, '') not in ('sandbox', 'production') then
    raise exception 'O ambiente da cobranca (LIVE/SANDBOX) nao esta identificado.';
  end if;
  v_amount := coalesce(v_payment.final_amount, v_payment.amount, 0);
  if v_amount <= 0 then raise exception 'So e possivel estornar um valor maior que zero.'; end if;
  if v_payment.payment_status = 'pending' then raise exception 'Pagamento pendente ainda nao foi confirmado.'; end if;
  if v_payment.payment_status in ('cancelled', 'canceled') then raise exception 'Pagamento cancelado nao pode ser estornado.'; end if;
  if v_payment.payment_status = 'expired' then raise exception 'Pagamento expirado nao pode ser estornado.'; end if;
  if v_payment.payment_status <> 'paid' then raise exception 'So e possivel estornar um pagamento confirmado.'; end if;

  insert into public.payment_refund_attempts (
    payment_id, order_id, organization_id, event_id, requested_by,
    reason_code, reason_text, cancel_tickets, amount, environment,
    account_key, gateway_payment_id, status
  ) values (
    v_payment.id, v_payment.order_id, v_payment.organization_id, v_payment.event_id, v_actor,
    p_reason_code, v_reason_text, coalesce(p_cancel_tickets, false), v_amount, v_payment.gateway_environment,
    v_payment.gateway_account_key, v_payment.gateway_payment_id, 'requested'
  )
  returning * into v_attempt;

  update public.payments
  set refund_status = 'requested', updated_at = now()
  where id = v_payment.id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'payment_refund_requested',
    'payments',
    v_payment.id,
    v_payment.event_id,
    jsonb_build_object(
      'attempt_id', v_attempt.id,
      'actor_user_id', v_actor,
      'reason_code', p_reason_code,
      'reason_text', v_reason_text,
      'cancel_tickets', coalesce(p_cancel_tickets, false),
      'amount', v_amount,
      'environment', v_payment.gateway_environment,
      'account_key', v_payment.gateway_account_key,
      'gateway_payment_id', v_payment.gateway_payment_id
    )
  );

  return jsonb_build_object(
    'success', true,
    'already_open', false,
    'already_completed', false,
    'attempt_id', v_attempt.id,
    'payment_id', v_payment.id,
    'refund_status', 'requested',
    'attempt_status', 'requested',
    'cancel_tickets', v_attempt.cancel_tickets,
    'gateway_payment_id', v_attempt.gateway_payment_id,
    'account_key', v_attempt.account_key,
    'organization_id', v_payment.organization_id,
    'amount', v_amount
  );
end;
$$;

revoke all on function public.begin_admin_payment_refund(uuid, text, text, boolean) from public, anon;
grant execute on function public.begin_admin_payment_refund(uuid, text, text, boolean) to authenticated, service_role;

create or replace function public.mark_admin_payment_refund_attempt(
  p_attempt_id uuid,
  p_status text,
  p_failure_text text default null,
  p_gateway_response jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_attempt public.payment_refund_attempts%rowtype;
  v_response jsonb := coalesce(p_gateway_response, '{}'::jsonb);
begin
  if p_status not in ('requested', 'pending', 'completed', 'failed', 'uncertain') then
    raise exception 'Status de tentativa invalido: %', p_status;
  end if;

  select * into v_attempt from public.payment_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'Tentativa de estorno nao encontrada.'; end if;

  if v_attempt.status = 'completed' then
    return jsonb_build_object('success', true, 'changed', false, 'attempt_id', v_attempt.id, 'status', v_attempt.status);
  end if;

  -- completed so via finalize/apply_gateway. Aqui so pending/failed/uncertain.
  if p_status = 'completed' then
    raise exception 'Conclusao de estorno deve passar por finalize_payment_refund_side_effects.';
  end if;

  update public.payment_refund_attempts
  set status = p_status,
      failure_text = case when p_status = 'failed' then nullif(trim(coalesce(p_failure_text, '')), '') else failure_text end,
      gateway_response = case when v_response = '{}'::jsonb then gateway_response else v_response end,
      updated_at = now()
  where id = v_attempt.id;

  update public.payments
  set refund_status = p_status, updated_at = now()
  where id = v_attempt.payment_id
    and coalesce(refund_status, '') is distinct from 'completed'
    and payment_status is distinct from 'refunded';

  if p_status = 'failed' then
    perform public.notify_payment_refund_outcome(
      v_attempt.payment_id,
      'PAYMENT_REFUND_FAILED',
      'Falha ao estornar pagamento',
      coalesce(nullif(trim(coalesce(p_failure_text, '')), ''), 'Nao foi possivel concluir o estorno administrativo.')
    );
  end if;

  return jsonb_build_object('success', true, 'changed', true, 'attempt_id', v_attempt.id, 'status', p_status);
end;
$$;

revoke all on function public.mark_admin_payment_refund_attempt(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mark_admin_payment_refund_attempt(uuid, text, text, jsonb) to service_role;

create or replace function public.notify_payment_refund_outcome(
  p_payment_id uuid,
  p_type text,
  p_title text,
  p_body text
) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
begin
  if p_type not in ('PAYMENT_REFUNDED', 'PAYMENT_REFUND_FAILED') then
    raise exception 'Tipo de notificacao de estorno invalido.';
  end if;
  select * into v_payment from public.payments where id = p_payment_id;
  if not found then return; end if;

  insert into public.organization_notifications (
    organization_id, event_id, type, title, body, entity_type, entity_id, action_href, created_by
  ) values (
    v_payment.organization_id,
    v_payment.event_id,
    p_type,
    p_title,
    p_body,
    'payments',
    v_payment.id,
    '/financeiro/pagamento/' || v_payment.id::text,
    null
  )
  on conflict (organization_id, type, entity_id) do nothing;
end;
$$;

revoke all on function public.notify_payment_refund_outcome(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.notify_payment_refund_outcome(uuid, text, text, text) to service_role;

create or replace function public.finalize_payment_refund_side_effects(p_payment_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_attempt public.payment_refund_attempts%rowtype;
  v_ticket_result jsonb := jsonb_build_object('skipped', true);
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    return jsonb_build_object('success', false, 'reason', 'not_found');
  end if;

  update public.payments
  set refund_status = 'completed', updated_at = now()
  where id = v_payment.id;

  update public.payment_refund_attempts
  set status = 'completed',
      completed_at = coalesce(completed_at, now()),
      updated_at = now()
  where payment_id = v_payment.id
    and status in ('requested', 'pending', 'uncertain', 'failed');

  select * into v_attempt
  from public.payment_refund_attempts
  where payment_id = v_payment.id
  order by requested_at desc
  limit 1;

  if found and v_attempt.cancel_tickets then
    v_ticket_result := public.apply_refund_linked_entitlement_cancellations(v_attempt.id);
  end if;

  perform public.notify_payment_refund_outcome(
    v_payment.id,
    'PAYMENT_REFUNDED',
    'Pagamento estornado',
    'O estorno do pagamento foi confirmado.'
  );

  return jsonb_build_object('success', true, 'payment_id', v_payment.id, 'tickets', v_ticket_result);
end;
$$;

revoke all on function public.finalize_payment_refund_side_effects(uuid) from public, anon, authenticated;
grant execute on function public.finalize_payment_refund_side_effects(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6) apply_gateway_payment_status: apos refunded, finaliza tentativa/notifica
--    (corpo vigente 20261007 + finalize_payment_refund_side_effects)
-- ---------------------------------------------------------------------------
create or replace function public.apply_gateway_payment_status(
  p_provider text,
  p_provider_payment_id text,
  p_provider_status text,
  p_internal_status text,
  p_paid_at timestamptz default null,
  p_fee_amount numeric default null,
  p_net_amount numeric default null,
  p_expected_gateway_account_key text default null,
  p_event_type text default null
)
returns table(payment_id uuid, order_id uuid, organization_id uuid, previous_status text, applied_status text)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment public.payments%rowtype;
  v_charge public.payment_gateway_charges%rowtype;
  v_previous text;
  v_applied text;
  v_expected_key text := nullif(trim(coalesce(p_expected_gateway_account_key, '')), '');
  v_event text := upper(trim(coalesce(p_event_type, '')));
  v_has_charge boolean := false;
begin
  if p_internal_status not in ('pending','processing','paid','expired','cancelled','refunded','chargeback','failed') then
    raise exception 'Status interno invalido: %', p_internal_status;
  end if;
  if nullif(trim(coalesce(p_provider_payment_id,'')),'') is null then
    raise exception 'provider_payment_id obrigatorio.';
  end if;

  if v_expected_key is not null then
    select * into v_charge
    from public.payment_gateway_charges
    where provider = p_provider
      and gateway_payment_id = p_provider_payment_id
      and coalesce(gateway_account_key, '') = v_expected_key
    order by created_at
    limit 1
    for update;
    v_has_charge := found;

    if not v_has_charge and exists (
      select 1 from public.payment_gateway_charges
      where provider = p_provider
        and gateway_payment_id = p_provider_payment_id
    ) then
      raise exception using errcode='P0001', message='GATEWAY_ACCOUNT_MISMATCH',
        detail=jsonb_build_object('code','GATEWAY_ACCOUNT_MISMATCH','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
    end if;
  else
    select * into v_charge
    from public.payment_gateway_charges
    where provider = p_provider
      and gateway_payment_id = p_provider_payment_id
    order by created_at
    limit 1
    for update;
    v_has_charge := found;
  end if;

  if v_has_charge then
    select * into v_payment from public.payments where id = v_charge.payment_id for update;
    if not found then
      raise exception using errcode='P0001', message='PAYMENT_NOT_FOUND',
        detail=jsonb_build_object('code','PAYMENT_NOT_FOUND','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
    end if;
    if v_expected_key is not null then
      if v_payment.gateway_account_key is not null
        and v_payment.gateway_account_key is distinct from v_expected_key then
        raise exception using errcode='P0001', message='GATEWAY_ACCOUNT_MISMATCH',
          detail=jsonb_build_object('code','GATEWAY_ACCOUNT_MISMATCH','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
      end if;
    end if;
    if v_payment.gateway_payment_id is null
      or not v_charge.reusable
      or v_charge.deleted
      or (
        v_payment.gateway_payment_id is distinct from p_provider_payment_id
        and (
          v_payment.gateway_installment_id is null
          or v_charge.gateway_installment_id is null
          or v_payment.gateway_installment_id is distinct from v_charge.gateway_installment_id
        )
      ) then
      raise exception using errcode='P0001', message='PAYMENT_NOT_FOUND',
        detail=jsonb_build_object('code','PAYMENT_NOT_FOUND','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
    end if;
  else
    if v_expected_key is not null then
      select * into v_payment
      from public.payments
      where provider = p_provider
        and gateway_payment_id = p_provider_payment_id
        and coalesce(gateway_account_key, '') = v_expected_key
      for update;

      if not found then
        if exists (
          select 1 from public.payments
          where provider = p_provider and gateway_payment_id = p_provider_payment_id
        ) then
          raise exception using errcode='P0001', message='GATEWAY_ACCOUNT_MISMATCH',
            detail=jsonb_build_object('code','GATEWAY_ACCOUNT_MISMATCH','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
        end if;
        raise exception using errcode='P0001', message='PAYMENT_NOT_FOUND',
          detail=jsonb_build_object('code','PAYMENT_NOT_FOUND','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
      end if;
    else
      select * into v_payment
      from public.payments
      where provider = p_provider and gateway_payment_id = p_provider_payment_id
      for update;
      if not found then
        raise exception using errcode='P0001', message='PAYMENT_NOT_FOUND',
          detail=jsonb_build_object('code','PAYMENT_NOT_FOUND','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
      end if;
    end if;
  end if;

  v_previous := v_payment.payment_status;

  if v_event in ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED') then
    p_internal_status := 'refunded';
    if coalesce(upper(trim(p_provider_status)), '') in ('', 'RECEIVED', 'CONFIRMED', 'PENDING', 'RECEIVED_IN_CASH') then
      p_provider_status := case when v_event = 'PAYMENT_REFUNDED' then 'REFUNDED' else 'PARTIALLY_REFUNDED' end;
    end if;
  end if;

  if v_has_charge then
    if v_event = 'PAYMENT_DELETED' or p_internal_status in ('cancelled', 'expired') then
      update public.payment_gateway_charges
      set gateway_status = coalesce(p_provider_status, gateway_status),
          deleted = (v_event = 'PAYMENT_DELETED' or p_internal_status = 'cancelled'),
          reusable = false,
          updated_at = now()
      where id = v_charge.id;
    else
      update public.payment_gateway_charges
      set gateway_status = coalesce(p_provider_status, gateway_status),
          updated_at = now()
      where id = v_charge.id;
    end if;
  end if;

  if v_event = 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED' then
    if v_previous = 'pending' then
      update public.payments
      set last_gateway_attempt_status = 'refused',
          provider_status = p_provider_status,
          updated_at = now()
      where id = v_payment.id;
      insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
      values (
        'payment_card_capture_refused',
        'payments',
        v_payment.id,
        v_payment.event_id,
        jsonb_build_object(
          'provider', p_provider,
          'provider_payment_id', p_provider_payment_id,
          'provider_status', p_provider_status,
          'order_id', v_payment.order_id
        )
      );
    end if;
    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
    return;
  end if;

  if v_event = 'PAYMENT_DELETED' then
    update public.payments
    set provider_status = coalesce(p_provider_status, provider_status),
        updated_at = now()
    where id = v_payment.id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'payment_gateway_charge_deleted',
      'payments',
      v_payment.id,
      v_payment.event_id,
      jsonb_build_object(
        'provider', p_provider,
        'provider_payment_id', p_provider_payment_id,
        'order_id', v_payment.order_id
      )
    );
    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status in ('processing','chargeback','failed') then
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('payment_gateway_signal_'||p_internal_status,'payments',v_payment.id,v_payment.event_id,
      jsonb_build_object('provider',p_provider,'provider_payment_id',p_provider_payment_id,'provider_status',p_provider_status,'order_id',v_payment.order_id));
    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status = 'pending' then
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status = 'paid' then
    if v_previous = 'paid' then
      update public.payments
      set provider_status = p_provider_status,
          last_gateway_attempt_status = null,
          updated_at = now()
      where id = v_payment.id;
      return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, 'paid';
      return;
    end if;

    update public.payments set
      payment_status = 'paid',
      provider_status = p_provider_status,
      last_gateway_attempt_status = null,
      paid_at = coalesce(p_paid_at, now()),
      fee_amount = coalesce(p_fee_amount, fee_amount),
      net_amount = coalesce(p_net_amount, net_amount),
      expires_at = null,
      updated_at = now()
    where id = v_payment.id;

    if v_previous <> 'pending' then
      insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
      values('payment_paid_after_'||v_previous,'payments',v_payment.id,v_payment.event_id,
        jsonb_build_object('provider',p_provider,'provider_payment_id',p_provider_payment_id,'order_id',v_payment.order_id,
          'previous_status',v_previous,'needs_manual_reconciliation',true));
      return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, 'paid';
      return;
    end if;

    if v_payment.order_id is not null then
      perform public.confirm_order_payment_and_issue_tickets(v_payment.order_id);
    end if;

    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, 'paid';
    return;
  end if;

  if v_previous = 'paid' and p_internal_status = 'refunded' then
    perform public._apply_terminal_order_payment_status(v_payment.id, 'refunded');
    perform public.finalize_payment_refund_side_effects(v_payment.id);
  elsif v_previous = 'refunded' and p_internal_status = 'refunded' then
    update public.payments set provider_status = p_provider_status, refund_status = 'completed', updated_at = now() where id = v_payment.id;
    perform public.finalize_payment_refund_side_effects(v_payment.id);
  elsif v_previous = 'pending' then
    perform public._apply_terminal_order_payment_status(v_payment.id, p_internal_status);
  elsif v_previous = p_internal_status then
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
  else
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('payment_gateway_status_conflict_ignored','payments',v_payment.id,v_payment.event_id,
      jsonb_build_object('provider',p_provider,'provider_payment_id',p_provider_payment_id,'order_id',v_payment.order_id,
        'previous_status',v_previous,'incoming_status',p_internal_status));
  end if;

  select payment_status into v_applied from public.payments where id = v_payment.id;
  return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_applied;
end;
$$;

revoke all on function public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric, text, text)
from public, anon, authenticated;
grant execute on function public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric, text, text)
to service_role;

commit;
