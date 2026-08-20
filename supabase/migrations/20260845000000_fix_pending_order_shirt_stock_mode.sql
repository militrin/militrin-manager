-- Correcao incremental sobre change_pending_order_item_shirt
-- (20260844000000_self_service_pending_order_item_shirt.sql), que ja esta
-- aplicada no Supabase remoto -- por isso este e um NOVO migration, nunca
-- uma reescrita daquele arquivo historico.
--
-- Bug: a RPC 44 bloqueia a troca com "Estoque insuficiente para o
-- modelo/tamanho selecionado." sempre que available_quantity<1 pra variante
-- nova, INDEPENDENTE de events.limit_shirt_selection_to_stock. Isso diverge
-- da regra ja usada na CRIACAO do pedido (create_multi_ticket_order_checkout,
-- 20260815001914_remote_schema.sql): quando o evento tem
-- limit_shirt_selection_to_stock=false (compra sob encomenda), a criacao
-- reserva a camiseta sem checar disponibilidade fisica -- so exige que a
-- variante exista (linha em shirt_inventory pro event_id+shirt_type+
-- shirt_size). Um comprador editando um pedido pending de um evento "sob
-- encomenda" nao deveria ficar mais restrito do que estava na hora de
-- comprar.
--
-- Correcao: le events.limit_shirt_selection_to_stock (mesmo campo, mesma
-- semantica que o dispatcher de criacao ja usa) e so aplica o bloqueio de
-- "estoque insuficiente" quando esse flag e true. Com o flag false, a troca
-- segue permitida mesmo com available_quantity<=0 -- a reserva antiga ainda
-- e liberada e a nova ainda e registrada normalmente (mesma contabilidade de
-- sempre, so sem o gate de bloqueio).
--
-- Contrato preservado integralmente da 44 (create or replace function exige
-- o corpo inteiro, nao um patch parcial -- mas nenhuma outra regra mudou):
--   - ownership: v_order.user_id = actor OU acesso via organizacao;
--   - pedido precisa estar pending E, se houver payment, payment_status
--     pending e dentro do prazo de reserva (expires_at);
--   - order_item precisa pertencer ao order_id informado e ser item_kind='ticket'
--     ativo (nao cancelled/expired/refunded/transferred);
--   - variante nova precisa existir em shirt_inventory pro event_id do pedido
--     (isso NUNCA foi relaxado -- so a checagem de QUANTIDADE disponivel);
--   - reserva antiga e liberada (reserved_quantity - 1, nunca abaixo de 0) e
--     a nova e incrementada (reserved_quantity + 1), cada uma com seu
--     inventory_movement de auditoria;
--   - delivered_quantity nunca e tocada;
--   - idempotencia: mesmo tipo/tamanho => no-op, "changed": false, sem mexer
--     em reserva;
--   - apply_cart_coupon reaplicado no final (recalcula orders/payments e
--     invalida PIX se o total mudar por qualquer motivo concorrente -- nunca
--     por causa da troca de camiseta em si, que nao afeta preco neste
--     schema: order_items nao tem coluna de genero, unit_price e fixado na
--     criacao do pedido);
--   - audit_logs registrado com o mesmo formato de sempre.
begin;

create or replace function public.change_pending_order_item_shirt(
  p_order_id uuid, p_order_item_id uuid, p_shirt_type text, p_shirt_size text
) returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_event public.events%rowtype;
  v_new_type text := nullif(trim(coalesce(p_shirt_type, '')), '');
  v_new_size text := nullif(trim(coalesce(p_shirt_size, '')), '');
  v_old_inventory public.shirt_inventory%rowtype;
  v_new_inventory public.shirt_inventory%rowtype;
  v_row public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_enforce_physical_stock boolean;
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

  -- Fix (20260845000000): mesma regra ja usada na criacao do pedido -- so
  -- exige estoque fisico disponivel quando o evento esta configurado pra
  -- isso. coalesce(...,false) preserva o comportamento antigo (bloquear) se
  -- o evento nao for encontrado por algum motivo (v_event.id null), nunca
  -- afrouxa por omissao.
  select * into v_event from public.events where id = v_order.event_id;
  v_enforce_physical_stock := coalesce(v_event.limit_shirt_selection_to_stock, false);

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

  -- Existencia da variante pro evento continua obrigatoria em qualquer modo
  -- (fisico ou sob encomenda) -- e o que define quais combinacoes sao
  -- ofertadas pro evento, nunca relaxado por este fix.
  if v_new_inventory.id is null then
    raise exception 'Estoque nao encontrado para este modelo e tamanho.';
  end if;

  v_available_stock := coalesce(v_new_inventory.total_quantity, 0) - coalesce(v_new_inventory.reserved_quantity, 0) - coalesce(v_new_inventory.delivered_quantity, 0);
  if v_enforce_physical_stock and v_available_stock < 1 then
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
