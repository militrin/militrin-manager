-- Motor de carrinho + cupom item-a-item. Reaproveita a cadeia canonica
-- orders/order_items/payments/tickets e a cadeia de estoque de produto ja
-- existente (store_items/store_item_variants/store_item_inventory) -- nao
-- cria pedido paralelo, nao cria estoque paralelo.
--
-- Fluxo novo: o pedido nasce (via create_multi_ticket_order_checkout, JA
-- EXISTENTE, inalterada) no momento em que o comprador termina a etapa
-- "Dados" -- ainda sem cupom (coupon_code fica para a etapa Carrinho) e sem
-- metodo de pagamento definitivo (o pedido fica em status pending/reserved,
-- exatamente como ja acontece hoje pra pedidos nao pagos instantaneamente).
-- Na etapa Carrinho, o comprador pode: adicionar/remover produtos do "compre
-- junto" (add_product_to_cart_order/remove_cart_order_item) e aplicar/trocar/
-- remover cupom (apply_cart_coupon) -- cada uma dessas acoes RECALCULA tudo
-- do zero a partir do estado real do pedido no banco (nunca confia em nada
-- vindo do cliente). Na etapa final, finalize_cart_order_payment decide o
-- metodo de pagamento e confirma (reusa confirm_order_item_and_issue_ticket
-- para ingressos, sem duplicar a logica de emissao).
begin;

-- ============================================================
-- 1. orders ganha o vinculo com o cupom atualmente aplicado (necessario pra
--    used_count so contar 1x por pedido, nao 1x por recalculo).
-- ============================================================

alter table public.orders add column applied_coupon_id uuid references public.coupons(id);

-- ============================================================
-- 2. Snapshot historico e auditavel do desconto aplicado por item -- nao
--    depende de recalcular com a config ATUAL do cupom (que pode mudar
--    depois). Uma linha por item que recebeu desconto na ultima aplicacao.
-- ============================================================

create table public.order_item_discounts (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  coupon_id uuid references public.coupons(id),
  coupon_code text not null,
  discount_type text not null,
  discount_value numeric not null,
  base_amount numeric(10,2) not null,
  discount_amount numeric(10,2) not null,
  final_amount numeric(10,2) not null,
  created_at timestamptz not null default now(),
  unique(order_item_id)
);
comment on table public.order_item_discounts is 'Snapshot imutavel do desconto aplicado a um order_item no momento em que foi calculado -- coupon_code/discount_type/discount_value sao copias, nao referencias vivas, entao alterar o cupom depois nao muda o historico do pedido.';

create index idx_order_item_discounts_order_item on public.order_item_discounts(order_item_id);

alter table public.order_item_discounts enable row level security;
create policy order_item_discounts_select on public.order_item_discounts for select
  using (exists(
    select 1 from public.order_items oi join public.orders o on o.id = oi.order_id
    where oi.id = order_item_id
      and (o.user_id = auth.uid() or public.user_is_order_item_holder(auth.uid(), o.id)
        or public.is_platform_owner(auth.uid())
        or (public.user_can_access_organization(auth.uid(), o.organization_id)
          and (public.is_active_owner(auth.uid()) or public.resolve_user_permission(auth.uid(),'orders.view') or public.resolve_user_permission(auth.uid(),'finance.view'))))
  ));

-- ============================================================
-- 3. Elegibilidade de um item a um cupom -- fonte unica de verdade, usada
--    tanto no calculo real quanto (se preciso) em telas de diagnostico.
-- ============================================================

create or replace function public.is_order_item_eligible_for_coupon(
  p_coupon_id uuid, p_item_kind text, p_event_id uuid, p_ticket_category_id uuid, p_store_item_id uuid
) returns boolean language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select case
    when p_item_kind = 'ticket' then
      exists(select 1 from public.coupons c where c.id = p_coupon_id and c.applies_to_tickets)
      and (
        not exists(select 1 from public.coupon_event_scopes s where s.coupon_id = p_coupon_id)
        or exists(select 1 from public.coupon_event_scopes s where s.coupon_id = p_coupon_id and s.event_id = p_event_id)
      )
      and (
        p_ticket_category_id is null
        or not exists(
          select 1 from public.coupon_ticket_category_scopes s
          join public.ticket_categories tc on tc.id = s.ticket_category_id
          where s.coupon_id = p_coupon_id and tc.event_id = p_event_id
        )
        or exists(select 1 from public.coupon_ticket_category_scopes s where s.coupon_id = p_coupon_id and s.ticket_category_id = p_ticket_category_id)
      )
    when p_item_kind = 'product' then
      exists(select 1 from public.coupons c where c.id = p_coupon_id and c.applies_to_products)
      and (
        not exists(select 1 from public.coupon_product_scopes s where s.coupon_id = p_coupon_id)
        or exists(select 1 from public.coupon_product_scopes s where s.coupon_id = p_coupon_id and s.store_item_id = p_store_item_id)
      )
    else false
  end;
$$;

-- ============================================================
-- 4. Motor de aplicacao do cupom -- autoridade unica de calculo. Sempre
--    recalcula do zero a partir do estado REAL do pedido no banco.
-- ============================================================

create or replace function public.apply_cart_coupon(p_order_id uuid, p_coupon_code text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_coupon public.coupons%rowtype;
  v_code text := upper(trim(coalesce(p_coupon_code, '')));
  v_item record;
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

  -- Sem codigo: limpa qualquer desconto/cupom aplicado.
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

  -- Passo 1: elegibilidade e subtotal elegivel, olhando o carrinho REAL.
  for v_item in
    select id, item_kind, event_id, ticket_category_id, store_item_id, unit_price
    from public.order_items
    where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')
    order by item_position nulls last, created_at, id
    for update
  loop
    v_total_subtotal := v_total_subtotal + v_item.unit_price;
    if v_coupon.id is not null and public.is_order_item_eligible_for_coupon(v_coupon.id, v_item.item_kind, v_item.event_id, v_item.ticket_category_id, v_item.store_item_id) then
      v_eligible_subtotal := v_eligible_subtotal + v_item.unit_price;
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

  -- Passo 2: distribui o desconto item a item (nunca sobre itens nao
  -- elegiveis, nunca gera total negativo). O ultimo item elegivel absorve o
  -- resto do arredondamento, garantindo soma exata.
  delete from public.order_item_discounts where order_item_id in (select id from public.order_items where order_id = p_order_id);
  v_allocated := 0;
  for v_item in
    select id, item_kind, event_id, ticket_category_id, store_item_id, unit_price,
      row_number() over (order by item_position nulls last, created_at, id) as rn,
      count(*) over () as total_rows
    from public.order_items
    where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')
  loop
    v_item_discount := 0;
    if v_coupon.id is not null and v_eligible_subtotal > 0
      and public.is_order_item_eligible_for_coupon(v_coupon.id, v_item.item_kind, v_item.event_id, v_item.ticket_category_id, v_item.store_item_id) then
      if v_item.rn = v_item.total_rows then
        v_item_discount := v_total_discount - v_allocated;
      else
        v_item_discount := round(v_item.unit_price / v_eligible_subtotal * v_total_discount, 2);
      end if;
      v_item_discount := greatest(0, least(v_item_discount, v_item.unit_price));
      v_allocated := v_allocated + v_item_discount;
    end if;

    update public.order_items
    set discount_amount = v_item_discount, final_amount = round(unit_price - v_item_discount, 2), updated_at = now()
    where id = v_item.id;

    if v_item_discount > 0 then
      insert into public.order_item_discounts(order_item_id, coupon_id, coupon_code, discount_type, discount_value, base_amount, discount_amount, final_amount)
      values (v_item.id, v_coupon.id, v_coupon.code, v_coupon.discount_type, v_coupon.discount_value, v_item.unit_price, v_item_discount, round(v_item.unit_price - v_item_discount, 2));
    end if;
  end loop;

  -- Passo 3: used_count so muda quando o cupom REALMENTE muda neste pedido
  -- (nao a cada recalculo do mesmo cupom apos add/remove de item).
  if v_previous_coupon_id is not null and v_previous_coupon_id is distinct from v_coupon.id then
    update public.coupons set used_count = greatest(used_count - 1, 0), updated_at = now() where id = v_previous_coupon_id;
  end if;
  if v_coupon.id is not null and v_previous_coupon_id is distinct from v_coupon.id then
    update public.coupons set used_count = used_count + 1, updated_at = now() where id = v_coupon.id;
  end if;

  update public.orders set applied_coupon_id = v_coupon.id, base_amount = v_total_subtotal,
    discount_amount = v_allocated, final_amount = round(v_total_subtotal - v_allocated, 2)
  where id = p_order_id;

  update public.payments set amount = v_total_subtotal, discount_amount = v_allocated,
    final_amount = round(v_total_subtotal - v_allocated, 2), updated_at = now()
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

-- ============================================================
-- 5. Adicionar/remover produto do carrinho -- reserva/libera estoque na
--    MESMA tabela canonica ja usada pela loja solo (store_item_inventory).
-- ============================================================

create or replace function public.add_product_to_cart_order(p_order_id uuid, p_store_item_id uuid, p_variant_id uuid default null, p_quantity integer default 1)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_store_item public.store_items%rowtype;
  v_variant public.store_item_variants%rowtype; v_inv public.store_item_inventory%rowtype;
  v_unit_price numeric; v_i integer; v_created_ids uuid[] := array[]::uuid[]; v_item_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;

  select * into v_store_item from public.store_items where id = p_store_item_id
    and (event_id = v_order.event_id or event_id is null) and is_active and organization_id = v_order.organization_id;
  if not found then raise exception 'Produto indisponivel para este pedido.'; end if;
  if v_store_item.requires_variant and p_variant_id is null then raise exception 'Produto exige selecao de variante.'; end if;

  v_unit_price := v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o produto.'; end if;
    v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
  end if;

  if v_store_item.supply_mode = 'stock' then
    select * into v_inv from public.store_item_inventory where store_item_id = v_store_item.id and variant_id is not distinct from p_variant_id for update;
    if not found or coalesce(v_inv.total_quantity,0) - coalesce(v_inv.reserved_quantity,0) - coalesce(v_inv.delivered_quantity,0) < p_quantity then
      raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK', detail=jsonb_build_object('code','PRODUCT_OUT_OF_STOCK','message',format('Estoque insuficiente para %s.', v_store_item.name))::text;
    end if;
    update public.store_item_inventory set reserved_quantity = reserved_quantity + p_quantity, updated_at = now() where id = v_inv.id;
  end if;

  for v_i in 1..p_quantity loop
    insert into public.order_items(order_id, event_id, item_kind, store_item_id, store_item_variant_id, quantity, unit_price, discount_amount, final_amount, status, ownership_status)
    values(p_order_id, v_order.event_id, 'product', v_store_item.id, p_variant_id, 1, v_unit_price, 0, v_unit_price, 'reserved', 'unassigned')
    returning id into v_item_id;
    v_created_ids := v_created_ids || v_item_id;
  end loop;

  -- Recalcula (produto entrando pode mudar elegibilidade/desconto do cupom ja aplicado).
  perform public.apply_cart_coupon(p_order_id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_added', 'orders', p_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'store_item_id', v_store_item.id, 'variant_id', p_variant_id, 'quantity', p_quantity, 'order_item_ids', v_created_ids));

  return jsonb_build_object('order_item_ids', v_created_ids, 'unit_price', v_unit_price);
end; $$;

create or replace function public.remove_cart_order_item(p_order_item_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype; v_inv public.store_item_inventory%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item nao encontrado.'; end if;
  if v_item.item_kind <> 'product' then raise exception 'Somente itens de produto podem ser removidos do carrinho por aqui.'; end if;
  select * into v_order from public.orders where id = v_item.order_id for update;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;
  if v_item.status = 'cancelled' then return jsonb_build_object('order_id', v_order.id, 'already_removed', true); end if;

  select * into v_inv from public.store_item_inventory where store_item_id = v_item.store_item_id and variant_id is not distinct from v_item.store_item_variant_id for update;
  if found then
    update public.store_item_inventory set reserved_quantity = greatest(reserved_quantity - v_item.quantity, 0), updated_at = now() where id = v_inv.id;
  end if;

  update public.order_items set status = 'cancelled', discount_amount = 0, final_amount = 0, updated_at = now() where id = p_order_item_id;
  delete from public.order_item_discounts where order_item_id = p_order_item_id;

  perform public.apply_cart_coupon(v_order.id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_removed', 'orders', v_order.id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'order_item_id', p_order_item_id));

  return jsonb_build_object('order_id', v_order.id, 'removed', true);
end; $$;

-- ============================================================
-- 6. Confirmacao do pedido: reusa confirm_order_item_and_issue_ticket para
--    cada linha, agora ciente de item_kind (produto nunca vira ticket).
-- ============================================================

create or replace function public.confirm_order_item_and_issue_ticket(p_order_item_id uuid) returns uuid
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_event public.events%rowtype;
  v_payment public.payments%rowtype;
  v_ticket_id uuid;
begin
  if p_order_item_id is null then raise exception 'Item do pedido obrigatorio.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Item do pedido nao encontrado.'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if not found then raise exception 'Pedido nao encontrado para o item.'; end if;
  select * into v_event from public.events where id=v_item.event_id for share;
  if not found then raise exception 'Evento nao encontrado para o item.'; end if;

  if v_order.event_id is distinct from v_event.id then
    raise exception 'Evento do item diverge do evento do pedido.';
  end if;
  if v_order.organization_id is distinct from v_event.organization_id then
    raise exception 'Organizacao do pedido diverge da organizacao do evento.';
  end if;
  if v_item.participant_id is not null and exists(
    select 1 from public.participants p
    where p.id=v_item.participant_id and p.organization_id is distinct from v_event.organization_id
  ) then
    raise exception 'Organizacao do titular diverge da organizacao do evento.';
  end if;

  select * into v_payment from public.payments where order_id=v_order.id
  order by created_at desc limit 1 for update;
  if not found then raise exception 'Pagamento nao encontrado para o pedido.'; end if;
  if v_payment.payment_status<>'paid' then raise exception 'Pagamento ainda nao confirmado.'; end if;
  if v_payment.event_id is distinct from v_event.id
    or v_payment.organization_id is distinct from v_event.organization_id then
    raise exception 'Pagamento diverge do evento ou organizacao da emissao.';
  end if;

  -- Linha de PRODUTO (compre junto): confirma o item, nunca gera ticket.
  -- Estoque ja foi reservado em add_product_to_cart_order; entrega fisica e
  -- fluxo separado, fora do escopo desta etapa (mesmo padrao ja usado pela
  -- loja solo: reservar != entregar).
  if v_item.item_kind = 'product' then
    update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now()
    where id=v_item.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('order_item_product_confirmed','order_items',v_item.id,v_event.id,jsonb_build_object(
      'store_item_id',v_item.store_item_id,'order_id',v_order.id,'payment_id',v_payment.id,'organization_id',v_event.organization_id));
    return null;
  end if;

  update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now()
  where id=v_item.id;

  insert into public.tickets(order_id,order_item_id,participant_id,event_id,organization_id,status)
  values(v_order.id,v_item.id,v_item.participant_id,v_event.id,v_event.organization_id,'active')
  on conflict(order_item_id) where order_item_id is not null do update set
    order_id=excluded.order_id,
    participant_id=excluded.participant_id,
    event_id=excluded.event_id,
    organization_id=excluded.organization_id,
    status='active',cancelled_at=null,used_at=null
  returning id into v_ticket_id;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('ticket_issued','tickets',v_ticket_id,v_event.id,jsonb_build_object(
    'participant_id',v_item.participant_id,'order_id',v_order.id,'order_item_id',v_item.id,
    'payment_id',v_payment.id,'organization_id',v_event.organization_id));
  return v_ticket_id;
end; $$;

create or replace function public.finalize_cart_order_payment(p_order_id uuid, p_payment_method text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_payment public.payments%rowtype;
  v_status text; v_item record;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido ja foi finalizado.'; end if;
  if not exists(select 1 from public.order_items where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')) then
    raise exception 'Carrinho vazio.';
  end if;

  select * into v_payment from public.payments where order_id = p_order_id order by created_at desc limit 1 for update;
  if not found then raise exception 'Pagamento nao encontrado para o pedido.'; end if;

  v_status := case when lower(trim(coalesce(p_payment_method,''))) = 'courtesy' or v_order.final_amount <= 0 then 'paid' else 'pending' end;

  update public.payments set payment_method = trim(p_payment_method), payment_status = v_status,
    paid_at = case when v_status = 'paid' then coalesce(paid_at, now()) end, updated_at = now()
  where id = v_payment.id;

  update public.orders set status = case when v_status = 'paid' then 'confirmed' else 'pending' end,
    confirmed_at = case when v_status = 'paid' then coalesce(confirmed_at, now()) else confirmed_at end
  where id = p_order_id;

  if v_status = 'paid' then
    for v_item in select id from public.order_items where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred') loop
      perform public.confirm_order_item_and_issue_ticket(v_item.id);
    end loop;
  end if;

  return jsonb_build_object('order_id', p_order_id, 'payment_status', v_status, 'final_amount', v_order.final_amount);
end; $$;

revoke all on function public.apply_cart_coupon(uuid,text) from public,anon;
revoke all on function public.add_product_to_cart_order(uuid,uuid,uuid,integer) from public,anon;
revoke all on function public.remove_cart_order_item(uuid) from public,anon;
revoke all on function public.finalize_cart_order_payment(uuid,text) from public,anon;
grant execute on function public.apply_cart_coupon(uuid,text) to authenticated,service_role;
grant execute on function public.add_product_to_cart_order(uuid,uuid,uuid,integer) to authenticated,service_role;
grant execute on function public.remove_cart_order_item(uuid) to authenticated,service_role;
grant execute on function public.finalize_cart_order_payment(uuid,text) to authenticated,service_role;

commit;
