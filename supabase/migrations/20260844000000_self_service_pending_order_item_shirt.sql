-- Completa o modo "Editar pedido": faltava uma forma do PROPRIO comprador
-- trocar a camiseta/tamanho de um ingresso ja existente num pedido pending,
-- sem recriar o pedido. A unica RPC de troca de camiseta ate agora
-- (admin_change_ticket_shirt, 20260821000000_operations_kit_stock_and_rls_fixes.sql)
-- exige a permissao administrativa 'inventory.change_participant_shirt' e
-- opera sobre `event_kit_item_variant_inventory` -- a tabela de ENTREGA/kit
-- do operador, nao a de RESERVA do checkout self-service. Confirmado por
-- investigacao dedicada: `shirt_inventory` (chave event_id+shirt_type+
-- shirt_size) e a tabela que create_multi_ticket_order_checkout_legacy
-- reserva na criacao do pedido, que a pagina publica de inscricao le pra
-- mostrar disponibilidade, e que a tela administrativa de camisetas usa como
-- fonte -- e a que uma troca feita pelo PROPRIO comprador, num pedido ainda
-- pending, precisa ajustar (misturar com event_kit_item_variant_inventory
-- deixaria a reserva orfa, ja que as duas tabelas nao sao sincronizadas).
--
-- Contrato desta RPC: troca shirt_type/shirt_size de UM order_item
-- (item_kind='ticket') de um pedido que ainda e do proprio comprador e ainda
-- esta pending/dentro do prazo de reserva. Libera a reserva da variante
-- antiga, reserva a nova, nunca toca delivered_quantity, e reaplica
-- apply_cart_coupon no final -- que ja recalcula orders/payments e (desde
-- 20260843000000) invalida o PIX se o total mudar por qualquer motivo.
-- Camiseta nao afeta preco neste schema (male_price/female_price dependem so
-- de categoria+lote+genero), entao normalmente o total nao muda -- mas
-- reaplicar o cupom continua correto/barato como camada de consistencia.
begin;

create or replace function public.change_pending_order_item_shirt(
  p_order_id uuid, p_order_item_id uuid, p_shirt_type text, p_shirt_size text
) returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_new_type text := nullif(trim(coalesce(p_shirt_type, '')), '');
  v_new_size text := nullif(trim(coalesce(p_shirt_size, '')), '');
  v_old_inventory public.shirt_inventory%rowtype;
  v_new_inventory public.shirt_inventory%rowtype;
  v_row public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if v_new_type is null or v_new_size is null then
    raise exception 'Informe o tipo e o tamanho da camiseta.';
  end if;

  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item do pedido nao encontrado.'; end if;
  if v_item.order_id is distinct from p_order_id then
    raise exception 'Item nao pertence a este pedido.';
  end if;
  if v_item.item_kind <> 'ticket' then
    raise exception 'Somente ingressos tem camiseta editavel por aqui.';
  end if;
  if v_item.status in ('cancelled','expired','refunded','transferred') then
    raise exception 'Item nao esta mais ativo neste pedido.';
  end if;

  select * into v_order from public.orders where id = v_item.order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;
  if v_order.status <> 'pending' then
    raise exception 'Pedido nao esta mais no carrinho.';
  end if;

  select * into v_payment from public.payments where order_id = v_order.id order by created_at desc limit 1 for update;
  if found then
    if v_payment.payment_status <> 'pending' then
      raise exception 'Pedido nao esta mais no carrinho.';
    end if;
    if v_payment.expires_at is not null and v_payment.expires_at <= now() then
      raise exception 'O prazo de reserva deste pedido ja expirou.';
    end if;
  end if;

  -- Sem mudanca real: no-op idempotente, nunca mexe em reserva.
  if v_new_type = v_item.shirt_type and v_new_size = v_item.shirt_size then
    select jsonb_build_object(
      'order_id', v_order.id, 'order_item_id', p_order_item_id,
      'shirt_type', v_item.shirt_type, 'shirt_size', v_item.shirt_size, 'changed', false
    ) into v_result;
    return v_result;
  end if;

  -- Trava as duas linhas de estoque envolvidas (antiga e nova) numa unica
  -- consulta ordenada por id -- evita deadlock com uma troca concorrente no
  -- sentido oposto (item A: X->Y ao mesmo tempo que item B: Y->X).
  for v_row in
    select * from public.shirt_inventory
    where event_id = v_order.event_id
      and ((shirt_type = v_item.shirt_type and shirt_size = v_item.shirt_size)
        or (shirt_type = v_new_type and shirt_size = v_new_size))
    order by id
    for update
  loop
    if v_row.shirt_type = v_item.shirt_type and v_row.shirt_size = v_item.shirt_size then
      v_old_inventory := v_row;
    end if;
    if v_row.shirt_type = v_new_type and v_row.shirt_size = v_new_size then
      v_new_inventory := v_row;
    end if;
  end loop;

  if v_new_inventory.id is null then
    raise exception 'Estoque nao encontrado para este modelo e tamanho.';
  end if;

  v_available_stock := coalesce(v_new_inventory.total_quantity, 0) - coalesce(v_new_inventory.reserved_quantity, 0) - coalesce(v_new_inventory.delivered_quantity, 0);
  if v_available_stock < 1 then
    raise exception 'Estoque insuficiente para o modelo/tamanho selecionado.';
  end if;

  if v_old_inventory.id is not null then
    update public.shirt_inventory
    set reserved_quantity = greatest(reserved_quantity - 1, 0), updated_at = now()
    where id = v_old_inventory.id;

    insert into public.inventory_movements(event_id, inventory_id, movement_type, quantity, notes)
    values (v_order.event_id, v_old_inventory.id, 'adjustment', 1,
      format('Troca de camiseta (edicao de pedido pending) pedido %s: liberou %s/%s.', v_order.order_number, v_old_inventory.shirt_type, v_old_inventory.shirt_size));
  end if;

  update public.shirt_inventory
  set reserved_quantity = reserved_quantity + 1, updated_at = now()
  where id = v_new_inventory.id;

  insert into public.inventory_movements(event_id, inventory_id, movement_type, quantity, notes)
  values (v_order.event_id, v_new_inventory.id, 'adjustment', -1,
    format('Troca de camiseta (edicao de pedido pending) pedido %s: reservou %s/%s.', v_order.order_number, v_new_type, v_new_size));

  update public.order_items
  set shirt_type = v_new_type, shirt_size = v_new_size, updated_at = now()
  where id = p_order_item_id;

  -- Recalcula orders/payments a partir do carrinho real e, se o total tiver
  -- mudado por qualquer motivo, invalida o PIX (20260843000000) -- mesmo
  -- ponto unico ja reusado por add/remove/quantidade de produto e cupom.
  perform public.apply_cart_coupon(v_order.id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('order_item_shirt_changed', 'order_items', p_order_item_id, v_order.event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'order_id', v_order.id, 'order_item_id', p_order_item_id,
    'previous_shirt_type', v_item.shirt_type, 'previous_shirt_size', v_item.shirt_size,
    'new_shirt_type', v_new_type, 'new_shirt_size', v_new_size));

  select jsonb_build_object(
    'order_id', v_order.id, 'order_item_id', p_order_item_id,
    'shirt_type', v_new_type, 'shirt_size', v_new_size, 'changed', true
  ) into v_result;
  return v_result;
end; $$;

revoke all on function public.change_pending_order_item_shirt(uuid, uuid, text, text) from public, anon;
grant execute on function public.change_pending_order_item_shirt(uuid, uuid, text, text) to authenticated;

commit;
