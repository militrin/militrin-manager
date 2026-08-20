-- Bug real (achado ao investigar "editar pedido pendente"): mudar o
-- carrinho depois que o PIX ja foi gerado deixa o comprador pagando um valor
-- ERRADO. Rastreio completo:
--
--   generatePublicOrderPixAction (src/app/inscricao/actions.ts) so gera um
--   PIX novo quando `payment.pix_code` esta vazio -- se ja existir, devolve
--   o pix_code/pix_qrcode ANTIGOS na hora, sem checar se o valor mudou desde
--   entao (esse early-return em si esta correto -- existe pra nao gerar um
--   PIX novo a cada F5/reabertura de tela legitimos).
--
--   O problema e que NADA no motor do carrinho invalidava esses campos
--   quando o total realmente mudava. apply_cart_coupon (chamada por
--   add_product_to_cart_order, remove_cart_order_item,
--   set_cart_order_item_quantity E pela propria applyCartCouponAction) e o
--   UNICO ponto que recalcula/grava payments.final_amount a partir do
--   carrinho real -- mas so atualizava amount/discount_amount/final_amount,
--   nunca tocava pix_code/pix_qrcode/gateway_payment_id. Resultado: comprador
--   gera PIX de R$330, depois adiciona um produto (carrinho vai pra R$380),
--   e o PIX na tela continua sendo o QR code de R$330 -- pagavel, com valor
--   errado, silenciosamente.
--
-- Correcao: dentro do UPDATE que ja recalcula os valores de payments (unico
-- ponto de escrita, reusado por toda mutacao de carrinho -- nao criamos um
-- segundo mecanismo), zera pix_code/pix_qrcode/gateway_payment_id quando o
-- final_amount recem-calculado difere do que ja estava gravado. Isso faz
-- generatePublicOrderPixAction detectar corretamente "sem PIX valido" na
-- proxima vez que for chamada (seu early-return ja existente passa a
-- disparar geracao de um PIX NOVO, com o valor certo) -- sem precisar mudar
-- aquela action. expires_at (prazo da RESERVA, nao so do QR) nao e tocado
-- aqui.
begin;

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

  -- Passo 2: distribui o desconto item a item (nunca sobre itens nao
  -- elegiveis, nunca gera total negativo). O ultimo item elegivel absorve o
  -- resto do arredondamento, garantindo soma exata.
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

  -- Fix: invalida o PIX (pix_code/pix_qrcode/gateway_payment_id) sempre que
  -- o final_amount recalculado difere do que ja estava gravado -- nunca deixa
  -- um QR code antigo continuar valido com o valor errado depois de uma
  -- edicao no carrinho. `final_amount` do lado direito do `is distinct from`
  -- refere-se ao valor ANTIGO da linha (semantica padrao de UPDATE...SET no
  -- Postgres: expressoes no SET sao avaliadas contra a linha antes do
  -- update). expires_at (prazo da reserva) nao e tocado -- so o QR em si.
  update public.payments set amount = v_total_subtotal, discount_amount = v_allocated,
    final_amount = round(v_total_subtotal - v_allocated, 2), updated_at = now(),
    pix_code = case when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) then null else pix_code end,
    pix_qrcode = case when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) then null else pix_qrcode end,
    gateway_payment_id = case when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) then null else gateway_payment_id end
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

commit;
