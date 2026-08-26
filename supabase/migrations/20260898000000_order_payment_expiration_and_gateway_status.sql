begin;

-- Fase 1 Asaas -- expiracao moderna de orders/order_items/payments (o modelo
-- novo nunca teve isso: `release_expired_reservations()` so enxerga o modelo
-- legado `participants`, confirmado na auditoria) + aplicacao idempotente do
-- status vindo do gateway (usada pela rota de webhook) + preparo do
-- cancelamento de cobranca externa quando o carrinho muda.

-- ============================================================
-- 0. Colunas de apoio para o cancelamento da cobranca externa "orfa": quando
--    apply_cart_coupon precisa invalidar um pix_code/gateway_payment_id
--    porque o total mudou, a cobranca ainda existe DO LADO DO GATEWAY e
--    continuaria pagavel com o valor antigo se nao formos la cancela-la. Como
--    uma funcao de banco nao faz chamada HTTP, ela apenas marca a intencao
--    aqui; `popPendingExternalCancellations`/`cancel_pending_external_cancellation`
--    (chamados pela camada de aplicacao logo apos `apply_cart_coupon`) leem e
--    limpam essas colunas, chamando `PaymentGatewayProvider.cancelPayment(...)`.
alter table public.payments
  add column if not exists pending_cancel_provider text,
  add column if not exists pending_cancel_provider_payment_id text;

comment on column public.payments.pending_cancel_provider_payment_id is 'Id de cobranca externa que ficou orfa (carrinho mudou de valor) e ainda precisa ser cancelada no gateway. Limpo por pop_pending_external_cancellation apos o cancelamento remoto ter sucesso.';

create or replace function public.apply_cart_coupon(p_order_id uuid, p_coupon_code text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_coupon public.coupons%rowtype;
  v_code text := upper(trim(coalesce(p_coupon_code, '')));
  v_item record;
  v_line_subtotal numeric;
  v_eligible_subtotal numeric := 0;
  v_total_subtotal numeric := 0;
  v_total_discount numeric := 0;
  v_allocated numeric := 0;
  v_item_discount numeric;
  v_eligible_count integer := 0;
  v_now timestamptz := now();
  v_previous_coupon_id uuid;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;
  if v_order.status not in ('pending') then
    raise exception 'Pedido nao esta mais no carrinho (status atual: %).', v_order.status;
  end if;

  v_previous_coupon_id := v_order.applied_coupon_id;

  if v_code = '' then
    v_coupon.id := null;
  else
    select * into v_coupon from public.coupons where organization_id = v_order.organization_id and code = v_code for update;
    if not found then raise exception using errcode='P0001', message='COUPON_INVALID', detail=jsonb_build_object('code','COUPON_INVALID','message','Codigo de cupom invalido para esta organizacao.')::text; end if;
    if not v_coupon.is_active then raise exception using errcode='P0001', message='COUPON_INACTIVE', detail=jsonb_build_object('code','COUPON_INACTIVE','message','Cupom inativo.')::text; end if;
    if v_coupon.valid_from is not null and v_now < v_coupon.valid_from then raise exception using errcode='P0001', message='COUPON_NOT_YET_VALID', detail=jsonb_build_object('code','COUPON_NOT_YET_VALID','message','Cupom ainda nao esta vigente.')::text; end if;
    if v_coupon.valid_until is not null and v_now > v_coupon.valid_until then raise exception using errcode='P0001', message='COUPON_EXPIRED', detail=jsonb_build_object('code','COUPON_EXPIRED','message','Cupom expirado.')::text; end if;
    if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses
      and v_previous_coupon_id is distinct from v_coupon.id then
      raise exception using errcode='P0001', message='COUPON_USES_EXHAUSTED', detail=jsonb_build_object('code','COUPON_USES_EXHAUSTED','message','Limite de usos do cupom atingido.')::text;
    end if;
  end if;

  for v_item in
    select id, item_kind, event_id, ticket_category_id, store_item_id, unit_price, quantity
    from public.order_items
    where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')
    order by item_position nulls last, created_at, id
    for update
  loop
    v_line_subtotal := round(v_item.unit_price * coalesce(v_item.quantity, 1), 2);
    v_total_subtotal := v_total_subtotal + v_line_subtotal;
    if v_coupon.id is not null and public.is_order_item_eligible_for_coupon(v_coupon.id, v_item.item_kind, v_item.event_id, v_item.ticket_category_id, v_item.store_item_id) then
      v_eligible_subtotal := v_eligible_subtotal + v_line_subtotal;
      v_eligible_count := v_eligible_count + 1;
    end if;
  end loop;

  if v_coupon.id is not null and v_eligible_count = 0 then
    raise exception using errcode='P0001', message='COUPON_NO_ELIGIBLE_ITEMS', detail=jsonb_build_object('code','COUPON_NO_ELIGIBLE_ITEMS','message','Nenhum item do carrinho e elegivel para este cupom.')::text;
  end if;

  if v_coupon.id is not null then
    if v_coupon.discount_type = 'percentage' then
      v_total_discount := round(v_eligible_subtotal * v_coupon.discount_value / 100.0, 2);
    else
      v_total_discount := least(v_coupon.discount_value, v_eligible_subtotal);
    end if;
    v_total_discount := greatest(0, round(v_total_discount, 2));
  end if;

  delete from public.order_item_discounts where order_item_id in (select id from public.order_items where order_id = p_order_id);
  v_allocated := 0;
  for v_item in
    select id, item_kind, event_id, ticket_category_id, store_item_id, unit_price, quantity,
      row_number() over (order by item_position nulls last, created_at, id) as rn,
      count(*) over () as total_rows
    from public.order_items
    where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')
  loop
    v_line_subtotal := round(v_item.unit_price * coalesce(v_item.quantity, 1), 2);
    v_item_discount := 0;
    if v_coupon.id is not null and v_eligible_subtotal > 0
      and public.is_order_item_eligible_for_coupon(v_coupon.id, v_item.item_kind, v_item.event_id, v_item.ticket_category_id, v_item.store_item_id) then
      if v_item.rn = v_item.total_rows then
        v_item_discount := v_total_discount - v_allocated;
      else
        v_item_discount := round(v_line_subtotal / v_eligible_subtotal * v_total_discount, 2);
      end if;
      v_item_discount := greatest(0, least(v_item_discount, v_line_subtotal));
      v_allocated := v_allocated + v_item_discount;
    end if;

    update public.order_items
    set discount_amount = v_item_discount, final_amount = round(v_line_subtotal - v_item_discount, 2), updated_at = now()
    where id = v_item.id;

    if v_item_discount > 0 then
      insert into public.order_item_discounts(order_item_id, coupon_id, coupon_code, discount_type, discount_value, base_amount, discount_amount, final_amount)
      values (v_item.id, v_coupon.id, v_coupon.code, v_coupon.discount_type, v_coupon.discount_value, v_line_subtotal, v_item_discount, round(v_line_subtotal - v_item_discount, 2));
    end if;
  end loop;

  if v_previous_coupon_id is not null and v_previous_coupon_id is distinct from v_coupon.id then
    update public.coupons set used_count = greatest(used_count - 1, 0), updated_at = now() where id = v_previous_coupon_id;
  end if;
  if v_coupon.id is not null and v_previous_coupon_id is distinct from v_coupon.id then
    update public.coupons set used_count = used_count + 1, updated_at = now() where id = v_coupon.id;
  end if;

  update public.orders set applied_coupon_id = v_coupon.id, base_amount = v_total_subtotal,
    discount_amount = v_allocated, final_amount = round(v_total_subtotal - v_allocated, 2)
  where id = p_order_id;

  -- Fase 1 Asaas: alem de invalidar pix_code/pix_qrcode/gateway_payment_id
  -- quando o valor muda (comportamento ja existente, preservado), agora
  -- tambem preserva QUAL cobranca externa ficou orfa (provider +
  -- gateway_payment_id antigos) em pending_cancel_* -- para que a camada de
  -- aplicacao chame PaymentGatewayProvider.cancelPayment(...) nela e a
  -- cobranca antiga pare de ser pagavel no gateway com o preco velho.
  update public.payments set amount = v_total_subtotal, discount_amount = v_allocated,
    final_amount = round(v_total_subtotal - v_allocated, 2), updated_at = now(),
    pix_code = case when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) then null else pix_code end,
    pix_qrcode = case when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) then null else pix_qrcode end,
    gateway_payment_id = case when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) then null else gateway_payment_id end,
    pending_cancel_provider = case
      when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) and gateway_payment_id is not null and provider is not null
        then provider
      else pending_cancel_provider
    end,
    pending_cancel_provider_payment_id = case
      when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) and gateway_payment_id is not null and provider is not null
        then gateway_payment_id
      else pending_cancel_provider_payment_id
    end
  where order_id = p_order_id and payment_status = 'pending';

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_coupon_applied', 'orders', p_order_id, v_order.event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'coupon_id', v_coupon.id, 'coupon_code', nullif(v_code,''),
    'eligible_subtotal', v_eligible_subtotal, 'total_subtotal', v_total_subtotal, 'discount_amount', v_allocated));

  select jsonb_build_object(
    'order_id', p_order_id, 'coupon_id', v_coupon.id, 'coupon_code', nullif(v_code,''),
    'base_amount', v_total_subtotal, 'eligible_subtotal', v_eligible_subtotal,
    'discount_amount', v_allocated, 'final_amount', round(v_total_subtotal - v_allocated, 2)
  ) into v_result;
  return v_result;
end; $$;

-- Le e limpa (atomicamente) a marca de cancelamento pendente de um pedido,
-- para a camada de aplicacao processar o cancelamento remoto logo em
-- seguida. Chamada pela mesma action que ja chama apply_cart_coupon
-- (applyCartCouponAction) -- best-effort: se o cancelamento remoto falhar do
-- lado da aplicacao, a expiracao (abaixo) e a rede de seguranca final, ja que
-- o pix_code/gateway_payment_id local ja foi nulado e nunca mais sera
-- reconhecido por um webhook (record_payment_gateway_event so acha o
-- pagamento por provider+gateway_payment_id).
create or replace function public.pop_pending_external_cancellation(p_order_id uuid)
returns table(payment_id uuid, organization_id uuid, provider text, provider_payment_id text)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if v_actor is not null and not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  select * into v_payment from public.payments p
  where p.order_id = p_order_id and p.pending_cancel_provider_payment_id is not null
  order by created_at desc limit 1 for update;

  if not found then
    return;
  end if;

  update public.payments set pending_cancel_provider = null, pending_cancel_provider_payment_id = null
  where id = v_payment.id;

  return query select v_payment.id, v_payment.organization_id, v_payment.pending_cancel_provider, v_payment.pending_cancel_provider_payment_id;
end;
$$;

revoke all on function public.pop_pending_external_cancellation(uuid) from public;
grant execute on function public.pop_pending_external_cancellation(uuid) to authenticated, service_role;

-- ============================================================
-- 1. Cascata compartilhada para status TERMINAIS (expired/cancelled/refunded)
--    de um payment de carrinho. Usada tanto pela expiracao automatica quanto
--    pela aplicacao de status vindo do gateway (webhook). Pagamentos legados
--    (participant-based, order_id null) nao sao afetados por esta cascata --
--    ficam fora do escopo desta fase, que so cobre orders/order_items.
-- ============================================================
create or replace function public._apply_terminal_order_payment_status(p_payment_id uuid, p_target_status text)
returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_payment public.payments%rowtype;
begin
  if p_target_status not in ('expired','cancelled','refunded') then
    raise exception 'Status terminal invalido: %', p_target_status;
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then return; end if;

  update public.payments set
    payment_status = p_target_status,
    refunded_at = case when p_target_status = 'refunded' then coalesce(refunded_at, now()) else refunded_at end,
    expires_at = case when p_target_status in ('expired','cancelled') then null else expires_at end,
    updated_at = now()
  where id = p_payment_id;

  if v_payment.order_id is null then
    -- payment legado (participant-based) -- fora do escopo desta cascata.
    return;
  end if;

  if p_target_status = 'refunded' then
    update public.order_items set status = 'refunded', reservation_expires_at = null, updated_at = now()
    where order_id = v_payment.order_id and status not in ('cancelled','expired','refunded','transferred');

    -- Cancela so tickets ATIVOS -- ticket ja usado preserva historico (nao e
    -- reaberto nem apagado; uma reversao de check-in e decisao administrativa
    -- separada). Ticket ja cancelado permanece cancelado.
    update public.tickets set status = 'cancelled', cancelled_at = now()
    where order_id = v_payment.order_id and status = 'active';

    update public.orders set status = 'refunded' where id = v_payment.order_id;
  else
    update public.order_items set status = p_target_status, reservation_expires_at = null, updated_at = now()
    where order_id = v_payment.order_id and status = 'reserved';

    update public.orders set status = p_target_status where id = v_payment.order_id and status = 'pending';
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('payment_'||p_target_status, 'payments', p_payment_id, v_payment.event_id,
    jsonb_build_object('order_id', v_payment.order_id, 'provider', v_payment.provider, 'organization_id', v_payment.organization_id));
end;
$$;

revoke all on function public._apply_terminal_order_payment_status(uuid, text) from public, anon, authenticated;
grant execute on function public._apply_terminal_order_payment_status(uuid, text) to service_role;

-- ============================================================
-- 2. Expiracao moderna: varre payments 'pending' de carrinho (order_id nao
--    nulo) com expires_at vencido e os leva a 'expired' junto de
--    order/order_items -- o que release_expired_reservations() NUNCA fez
--    para este modelo. Transacional (cada iteracao e uma cascata atomica
--    dentro da mesma transacao da funcao), idempotente (so mexe em quem
--    ainda esta 'pending'), scoped por organizacao (parametro opcional) e
--    segura contra corrida com webhook de pagamento:
--
--    `for update skip locked` so pega linhas livres; se uma transacao de
--    webhook estiver com o lock daquele payment (aplicando 'paid'), esta
--    funcao simplesmente pula a linha nesta passada (pega na proxima
--    execucao, se ainda estiver pending) -- nunca espera/deadlocka. E se a
--    linha foi alterada e COMMITADA como 'paid' um instante antes deste
--    SELECT ... FOR UPDATE conseguir o lock, o Postgres reavalia o WHERE
--    (payment_status='pending') contra a versao mais recente antes de
--    entregar a linha (EvalPlanQual em READ COMMITTED) -- a linha
--    simplesmente nao aparece no cursor. Resultado: nunca terminamos com
--    "payment paid + order expired" nem com "ticket emitido + reserva
--    liberada", nao importa a ordem de chegada entre expiracao e webhook.
-- ============================================================
create or replace function public.expire_stale_order_payments(p_organization_id uuid default null)
returns integer
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_actor uuid := auth.uid();
  v_payment_id uuid;
  v_count integer := 0;
begin
  if v_actor is not null then
    if p_organization_id is null then
      raise exception 'organization_id obrigatorio para execucao manual.';
    end if;
    if not (public.current_user_has_permission('orders.cancel') and public.user_can_access_organization(v_actor, p_organization_id)) then
      raise exception 'Sem permissao para expirar pedidos desta organizacao.';
    end if;
  end if;

  for v_payment_id in
    select p.id from public.payments p
    where p.payment_status = 'pending'
      and p.order_id is not null
      and p.expires_at is not null
      and p.expires_at <= now()
      and (p_organization_id is null or p.organization_id = p_organization_id)
    order by p.expires_at
    for update skip locked
  loop
    perform public._apply_terminal_order_payment_status(v_payment_id, 'expired');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.expire_stale_order_payments(uuid) from public;
grant execute on function public.expire_stale_order_payments(uuid) to authenticated, service_role;

-- ============================================================
-- 3. Aplicacao idempotente do status reportado pelo gateway a um payment de
--    carrinho, identificado por (provider, gateway_payment_id). Chamada
--    exclusivamente pela rota /api/webhooks/asaas (service_role) depois que
--    o evento ja foi gravado de forma idempotente em payment_gateway_events
--    e o payload foi validado/mapeado para InternalPaymentStatus via
--    mapAsaasPaymentStatus (TypeScript) -- esta funcao nao conhece nada de
--    Asaas, so trabalha com o vocabulario interno.
--
--    Guarda de corrida (espelha a mesma regra de expire_stale_order_payments):
--    'paid' so dispara confirm_order_payment_and_issue_tickets quando o
--    payment ainda estava 'pending'. Se a expiracao ja tiver rodado primeiro
--    (payment_status <> 'pending'), o dinheiro recebido e sempre registrado
--    (payment_status vira 'paid', nunca perdemos o fato financeiro) mas a
--    emissao de ticket e DELIBERADAMENTE pulada e um audit_log de alta
--    visibilidade ('payment_paid_after_<status_anterior>') e gravado para
--    reconciliacao manual -- nunca reabrimos automaticamente uma reserva ja
--    liberada.
-- ============================================================
create or replace function public.apply_gateway_payment_status(
  p_provider text,
  p_provider_payment_id text,
  p_provider_status text,
  p_internal_status text,
  p_paid_at timestamptz default null,
  p_fee_amount numeric default null,
  p_net_amount numeric default null
)
returns table(payment_id uuid, order_id uuid, organization_id uuid, previous_status text, applied_status text)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_payment public.payments%rowtype;
  v_previous text;
  v_applied text;
begin
  if p_internal_status not in ('pending','processing','paid','expired','cancelled','refunded','chargeback','failed') then
    raise exception 'Status interno invalido: %', p_internal_status;
  end if;
  if nullif(trim(coalesce(p_provider_payment_id,'')),'') is null then
    raise exception 'provider_payment_id obrigatorio.';
  end if;

  select * into v_payment from public.payments
  where provider = p_provider and gateway_payment_id = p_provider_payment_id
  for update;

  if not found then
    raise exception using errcode='P0001', message='PAYMENT_NOT_FOUND',
      detail=jsonb_build_object('code','PAYMENT_NOT_FOUND','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
  end if;

  v_previous := v_payment.payment_status;

  -- Sinais informativos: nao existe coluna para eles em payment_status (que
  -- so aceita pending/paid/expired/cancelled/refunded, autoridade financeira
  -- estavel desde a fundacao do schema) -- ficam so em provider_status +
  -- audit_logs, para alerta/reconciliacao manual, sem mexer na maquina de
  -- estados de order/order_items/tickets.
  if p_internal_status in ('processing','chargeback','failed') then
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('payment_gateway_signal_'||p_internal_status,'payments',v_payment.id,v_payment.event_id,
      jsonb_build_object('provider',p_provider,'provider_payment_id',p_provider_payment_id,'provider_status',p_provider_status,'order_id',v_payment.order_id));
    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
    return;
  end if;

  -- 'pending' nunca dirige a maquina de estados sozinho (nunca "desconfirma"
  -- nada) -- so atualiza o status cru para visibilidade.
  if p_internal_status = 'pending' then
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status = 'paid' then
    if v_previous = 'paid' then
      -- Retry idempotente do mesmo webhook (ou de um segundo evento tambem
      -- de pagamento aprovado, ex.: CONFIRMED seguido de RECEIVED).
      update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
      return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, 'paid';
      return;
    end if;

    update public.payments set
      payment_status = 'paid',
      provider_status = p_provider_status,
      paid_at = coalesce(p_paid_at, now()),
      fee_amount = coalesce(p_fee_amount, fee_amount),
      net_amount = coalesce(p_net_amount, net_amount),
      expires_at = null,
      updated_at = now()
    where id = v_payment.id;

    if v_previous <> 'pending' then
      -- Expirado/cancelado localmente (ou ja estornado) antes do webhook
      -- chegar: dinheiro registrado, mas emissao automatica de ticket e
      -- deliberadamente pulada -- exige decisao humana (a reserva pode ja
      -- ter sido liberada para outra pessoa).
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

  -- Daqui em diante: p_internal_status in ('expired','cancelled','refunded').
  if v_previous = 'paid' and p_internal_status = 'refunded' then
    perform public._apply_terminal_order_payment_status(v_payment.id, 'refunded');
  elsif v_previous = 'pending' then
    perform public._apply_terminal_order_payment_status(v_payment.id, p_internal_status);
  elsif v_previous = p_internal_status then
    -- idempotente: ja estava neste mesmo status terminal.
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
  else
    -- Conflito (ex.: OVERDUE chegando depois que o pagamento ja esta 'paid',
    -- ou um estorno chegando sobre um pagamento ja 'expired'/'cancelled'):
    -- nunca sobrescreve um status ja decidido -- so registra o sinal.
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

revoke all on function public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric) from public, anon, authenticated;
grant execute on function public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric) to service_role;

commit;
