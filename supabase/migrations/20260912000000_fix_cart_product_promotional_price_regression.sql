-- Bug real (reportado no checkout publico, etapa 3 - Carrinho): "Compre
-- junto" mostra o preco promocional do produto (ex.: R$70 -> R$55) mas o
-- pedido cobra o preco cheio (R$70). Investigacao completa:
--
--   20260855000000_store_item_lifecycle_and_discount_pricing.sql implementou
--   CORRETAMENTE add_product_to_cart_order/set_cart_order_item_quantity pra
--   aplicar o desconto proprio do produto (compute_store_item_final_price,
--   a MESMA funcao usada pela loja solo e pela concessao administrativa) e
--   pra gravar product_base_unit_price (preco ANTES do desconto, senao
--   fica irrecuperavel depois que unit_price passa a guardar so o preco ja
--   promocional).
--
--   20260890000000_reconcile_unified_event_shirt_demand.sql, migration
--   POSTERIOR cujo objetivo real era corrigir o ROTEAMENTO DE ESTOQUE
--   (delegar pra reserve_store_item_stock/release_store_item_reservation em
--   vez de tocar store_item_inventory diretamente -- fix legitimo, mantido
--   aqui), recriou as duas funcoes a partir de uma base ANTIGA (pre-855):
--   v_unit_price := v_store_item.price puro, SEM chamar
--   compute_store_item_final_price, e SEM gravar product_base_unit_price.
--   Isso reverteu silenciosamente a correcao de preco -- e junto derrubou
--   tambem o guard "if v_store_item.visibility <> 'public'" que a 855 tinha
--   adicionado (achado colateral: um produto code_required/admin_only podia
--   voltar a ser adicionado via compre-junto). O frontend do card "Compre
--   junto" nunca teve esse bug -- le list_store_items_for_event e calcula
--   via computeStoreItemFinalPrice (src/lib/store/pricing.ts), caminho
--   nunca tocado pela 890 -- por isso a TELA mostrava R$55/R$60 enquanto o
--   ORDER_ITEM gravava R$70/R$75.
--
--   apply_cart_coupon (vigente desde 20260898000000) NAO precisa mudar: ja
--   usa unit_price*quantity como subtotal elegivel, entao uma vez unit_price
--   voltando a ser o preco promocional, cupom volta a incidir sobre o
--   subtotal promocional automaticamente (sem duplicar desconto) e a
--   invalidacao de PIX quando o total muda (20260843000000, dentro do mesmo
--   UPDATE de payments que apply_cart_coupon ja faz) continua funcionando
--   sem nenhuma alteracao.
--
-- Correcao: restaura o calculo de preco promocional (compute_store_item_
-- final_price + product_base_unit_price) e o guard de visibility, mas
-- MANTENDO o roteamento de estoque via reserve_store_item_stock/
-- release_store_item_reservation introduzido pela 890 (nao revertido --
-- essa parte estava certa). get_cart_order_details passa a devolver
-- product_base_unit_price por item (unico campo que faltava pro frontend
-- poder mostrar o preco original riscado a partir do snapshot canonico,
-- sem recalcular nada em paralelo).
begin;

-- add_product_to_cart_order -- volta a aplicar compute_store_item_final_price
-- (preco base + ajuste de variante -> desconto proprio do produto) e a
-- gravar product_base_unit_price tanto no INSERT quanto no UPDATE de
-- consolidacao de quantidade. reserve_store_item_stock continua sendo o
-- unico ponto de reserva de estoque (roteamento da 890, preservado).
create or replace function public.add_product_to_cart_order(p_order_id uuid, p_store_item_id uuid, p_variant_id uuid default null, p_quantity integer default 1)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_store_item public.store_items%rowtype;
  v_variant public.store_item_variants%rowtype;
  v_base_unit_price numeric; v_unit_price numeric; v_existing public.order_items%rowtype; v_item_id uuid; v_new_quantity integer;
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
  if v_store_item.visibility <> 'public' then raise exception 'Produto nao esta disponivel para compra publica.'; end if;
  if v_store_item.requires_variant and p_variant_id is null then raise exception 'Produto exige selecao de variante.'; end if;

  v_base_unit_price := v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o produto.'; end if;
    v_base_unit_price := v_base_unit_price + coalesce(v_variant.price_adjustment, 0);
  end if;
  v_unit_price := public.compute_store_item_final_price(v_base_unit_price, v_store_item.discount_type, v_store_item.discount_value);

  select * into v_existing from public.order_items where order_id = p_order_id and item_kind = 'product'
    and store_item_id = v_store_item.id and store_item_variant_id is not distinct from p_variant_id
    and status not in ('cancelled','expired','refunded','transferred') for update;

  perform public.reserve_store_item_stock(v_store_item.id, p_variant_id, p_quantity);

  if found and v_existing.id is not null then
    v_new_quantity := v_existing.quantity + p_quantity;
    update public.order_items
      set quantity = v_new_quantity, unit_price = v_unit_price, product_base_unit_price = v_base_unit_price,
        final_amount = round(v_unit_price * v_new_quantity, 2), updated_at = now()
      where id = v_existing.id
      returning id into v_item_id;
  else
    insert into public.order_items(order_id, event_id, item_kind, store_item_id, store_item_variant_id, quantity, unit_price, product_base_unit_price, discount_amount, final_amount, status, ownership_status)
    values(p_order_id, v_order.event_id, 'product', v_store_item.id, p_variant_id, p_quantity, v_unit_price, v_base_unit_price, 0, round(v_unit_price * p_quantity, 2), 'reserved', 'unassigned')
    returning id into v_item_id;
  end if;

  perform public.apply_cart_coupon(p_order_id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_added', 'orders', p_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'store_item_id', v_store_item.id, 'variant_id', p_variant_id, 'quantity_added', p_quantity, 'order_item_id', v_item_id, 'base_unit_price', v_base_unit_price, 'unit_price', v_unit_price));

  return jsonb_build_object('order_item_ids', array[v_item_id], 'unit_price', v_unit_price);
end; $$;

-- set_cart_order_item_quantity -- mesma correcao de preco (recalcula com
-- compute_store_item_final_price em vez de reverter pro preco cheio ao
-- mudar quantidade), mas mantendo o roteamento de estoque via
-- reserve_store_item_stock/release_store_item_reservation que a 890 ja
-- tinha corrigido (delta positivo reserva, delta negativo libera) -- nao
-- revertido para o acesso direto a store_item_inventory que a 855 usava.
create or replace function public.set_cart_order_item_quantity(p_order_item_id uuid, p_quantity integer)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_base_unit_price numeric; v_unit_price numeric; v_delta integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item nao encontrado.'; end if;
  if v_item.item_kind <> 'product' then raise exception 'Somente itens de produto tem quantidade ajustavel por aqui.'; end if;
  select * into v_order from public.orders where id = v_item.order_id for update;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;
  if v_item.status = 'cancelled' then raise exception 'Item ja foi removido do carrinho.'; end if;

  select * into v_store_item from public.store_items where id = v_item.store_item_id;
  if not found then raise exception 'Produto do item nao encontrado.'; end if;
  v_base_unit_price := v_store_item.price;
  if v_item.store_item_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = v_item.store_item_variant_id;
    if found then v_base_unit_price := v_base_unit_price + coalesce(v_variant.price_adjustment, 0); end if;
  end if;
  v_unit_price := public.compute_store_item_final_price(v_base_unit_price, v_store_item.discount_type, v_store_item.discount_value);

  v_delta := p_quantity - v_item.quantity;
  if v_delta > 0 then perform public.reserve_store_item_stock(v_item.store_item_id, v_item.store_item_variant_id, v_delta);
  elsif v_delta < 0 then perform public.release_store_item_reservation(v_item.store_item_id, v_item.store_item_variant_id, -v_delta); end if;

  update public.order_items
    set quantity = p_quantity, unit_price = v_unit_price, product_base_unit_price = v_base_unit_price,
      final_amount = round(v_unit_price * p_quantity, 2), updated_at = now()
    where id = p_order_item_id;

  perform public.apply_cart_coupon(v_order.id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_quantity_changed', 'orders', v_order.id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'order_item_id', p_order_item_id, 'quantity', p_quantity, 'previous_quantity', v_item.quantity));

  return jsonb_build_object('order_id', v_order.id, 'order_item_id', p_order_item_id, 'quantity', p_quantity);
end; $$;

-- get_cart_order_details -- unico campo novo no payload de cada item:
-- product_base_unit_price (ja gravado por add_product_to_cart_order/
-- set_cart_order_item_quantity desde a 855, mas nunca devolvido por esta
-- leitura). Sem ele o frontend nao tem como mostrar o preco original
-- riscado a partir do snapshot canonico -- e null pra linhas de ingresso
-- (item_kind='ticket'), mesmo padrao ja usado por shirt_type/pricing_gender
-- nesta mesma tabela polimorfica. Nenhum outro campo muda.
create or replace function public.get_cart_order_details(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_event public.events%rowtype;
  v_payment public.payments%rowtype; v_items jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  select * into v_event from public.events where id = v_order.event_id;
  select * into v_payment from public.payments where order_id = p_order_id order by created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', oi.id, 'item_kind', oi.item_kind, 'status', oi.status, 'quantity', oi.quantity,
    'item_position', oi.item_position, 'ownership_status', oi.ownership_status,
    'unit_price', oi.unit_price, 'product_base_unit_price', oi.product_base_unit_price, 'discount_amount', oi.discount_amount, 'final_amount', oi.final_amount,
    'ticket_category_id', oi.ticket_category_id, 'category_name', tc.name, 'batch_name', rb.name,
    'shirt_type', oi.shirt_type, 'shirt_size', oi.shirt_size, 'pricing_gender', oi.pricing_gender,
    'holder_full_name', oi.holder_full_name,
    'participant_id', oi.participant_id, 'participant_name', part.full_name,
    'ticket_id', t.id, 'ticket_status', t.status, 'ticket_token', t.token,
    'store_item_id', oi.store_item_id, 'store_item_name', si.name,
    'store_item_image_url', (select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1),
    'store_item_variant_id', oi.store_item_variant_id, 'variant_name', siv.name, 'variant_value', siv.value
  ) order by case oi.item_kind when 'ticket' then 0 else 1 end, oi.item_position nulls last, oi.created_at), '[]'::jsonb)
  into v_items
  from public.order_items oi
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.registration_batches rb on rb.id = oi.batch_id
  left join public.participants part on part.id = oi.participant_id
  left join public.tickets t on t.order_item_id = oi.id
  left join public.store_items si on si.id = oi.store_item_id
  left join public.store_item_variants siv on siv.id = oi.store_item_variant_id
  where oi.order_id = p_order_id and oi.status not in ('cancelled','expired','refunded','transferred');

  return jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number, 'order_status', v_order.status,
    'event_id', v_order.event_id, 'event_name', v_event.name,
    'status', v_order.status,
    'base_amount', v_order.base_amount, 'discount_amount', v_order.discount_amount, 'final_amount', v_order.final_amount,
    'applied_coupon_id', v_order.applied_coupon_id,
    'applied_coupon_code', (select code from public.coupons where id = v_order.applied_coupon_id),
    'payment', case when v_payment.id is null then null else jsonb_build_object(
      'payment_id', v_payment.id, 'amount', v_payment.amount, 'discount_amount', v_payment.discount_amount,
      'final_amount', v_payment.final_amount, 'payment_method', v_payment.payment_method, 'payment_status', v_payment.payment_status,
      'pix_code', v_payment.pix_code, 'pix_qrcode', v_payment.pix_qrcode, 'gateway_payment_id', v_payment.gateway_payment_id,
      'expires_at', v_payment.expires_at, 'paid_at', v_payment.paid_at
    ) end,
    'items', v_items
  );
end; $$;

-- NAO ha backfill automatico aqui de propósito: carrinhos PENDENTES que ja
-- tinham produto promocional adicionado antes desta migration (gravado com
-- o preco cheio pelo bug da 890) se AUTO-CORRIGEM na proxima interacao com o
-- carrinho (mudar quantidade, adicionar de novo, aplicar/reaplicar cupom --
-- todos os caminhos que chegam aqui ja recalculam com compute_store_item_
-- final_price). Um pedido pendente que NAO for tocado de novo pelo
-- comprador continua com o valor antigo ate isso acontecer. Corrigir esses
-- pedidos retroativamente exige reescrever orders/payments/pix_code em
-- producao (dado financeiro) -- decisao que fica fora desta migration,
-- para revisao explicita antes de rodar.
commit;
