-- Vazamento de reserva de estoque para produto "compre junto" (order_items.
-- item_kind='product'): auditoria confirmou que reserved_quantity (em
-- store_item_inventory OU event_kit_item_variant_inventory, a mesma
-- funcao canonica reserve_store_item_stock/release_store_item_reservation
-- ja roteia certo, ver 20260854000000/20260890000000) so e liberada
-- corretamente em DOIS dos caminhos que deveriam liberar: mudanca de
-- quantidade no carrinho (set_cart_order_item_quantity, delta negativo) e
-- cancelamento explicito por contato (owner_cancel_contact_items_and_tickets,
-- 20260891000000). Os outros dois caminhos auditados tinham bug real:
--
--   1) _apply_terminal_order_payment_status (20260903000000, chamada por
--      expire_stale_order_payments a cada 2min via pg_cron, e por
--      apply_gateway_payment_status no webhook Asaas) atualiza
--      order_items.status para 'expired'/'cancelled'/'refunded' mas NUNCA
--      chamava release_store_item_reservation para as linhas item_kind=
--      'product' -- reserva fica presa para sempre a cada PIX de produto
--      compre-junto nao pago/expirado, cancelado ou estornado.
--
--   2) remove_cart_order_item (20260827000000, nunca redefinida desde
--      entao) libera reserva tocando DIRETO em store_item_inventory --
--      escrito ANTES de release_store_item_reservation existir (introduzida
--      so na 20260890000000). Para produto vinculado a kit do evento
--      (store_items.linked_event_kit_item_id, cujo estoque real vive em
--      event_kit_item_variant_inventory, nao em store_item_inventory) essa
--      funcao nunca libera nada -- reserva tambem fica presa ao remover do
--      carrinho. Corrigido pra delegar ao mesmo helper canonico que
--      set_cart_order_item_quantity ja usa, eliminando a heuristica
--      duplicada.
--
-- Ciclo correto de reserved_quantity (documentado aqui pra nao divergir de
-- novo): aumenta em reserve_store_item_stock (add_product_to_cart_order
-- insere linha nova, ou set_cart_order_item_quantity com delta positivo).
-- Fica reservada durante TODO o ciclo comercial ate a entrega fisica --
-- confirmar pagamento (confirm_order_payment_and_issue_tickets /
-- confirm_order_item_and_issue_ticket) NAO mexe em estoque, so muda
-- order_items.status; a reserva so vira delivered_quantity em
-- deliver_store_item_stock (entrega fisica, deliver_order_item_product),
-- que decrementa reserved_quantity e incrementa delivered_quantity juntos,
-- na MESMA linha da inventory. Deve ser liberada (reserved_quantity
-- decrescido, nunca delivered_quantity) exatamente quando a reserva deixa
-- de existir sem nunca ter sido consumida: remocao do carrinho, reducao de
-- quantidade, expiracao do PIX, cancelamento ou estorno -- sempre e so
-- para itens que AINDA estao reservados (nunca para os ja 'delivered':
-- reserved_quantity de um item entregue ja foi zerada pela propria entrega,
-- chamar release de novo decrementaria a reserva de OUTRAS unidades ainda
-- pendentes do mesmo produto/variante, ja que reserved_quantity e agregada
-- por store_item+variante, nao por order_item).
--
-- Protecao contra dupla liberacao / negativo: release_store_item_reservation
-- ja faz reserved_quantity = greatest(reserved_quantity - quantidade, 0)
-- (nunca negativa) e "not found"/linha ausente nunca bloqueia (idempotente
-- por natureza). A idempotencia end-to-end desta correcao vem do padrao
-- "FOR ... IN UPDATE ... RETURNING ... LOOP": so libera estoque para as
-- linhas que ESTA chamada de fato transicionou (capturadas via RETURNING).
-- Uma segunda chamada de _apply_terminal_order_payment_status pro mesmo
-- payment nao encontra mais nenhuma order_item em status 'reserved'/nao-
-- terminal pra atualizar -- o UPDATE nao afeta linha nenhuma, o RETURNING
-- vem vazio, e nenhuma liberacao extra acontece. Mesma logica ja protegia
-- order_items.status/tickets/orders.status antes desta migration; a
-- liberacao de estoque agora e escopada exatamente da mesma forma.
--
-- Produto ja entregue nunca sofre liberacao indevida: o caminho 'refunded'
-- passa a excluir explicitamente status='delivered' do UPDATE (alem dos ja
-- excluidos cancelled/expired/refunded/transferred) -- um produto fisicamente
-- entregue permanece 'delivered' mesmo apos estorno do pagamento (nunca
-- volta a virar 'refunded' silenciosamente), no mesmo espirito de
-- owner_cancel_ticket ja bloquear cancelamento de ingresso com kit
-- entregue. O caminho 'expired'/'cancelled' so atinge status='reserved'
-- (pedido nunca chegou a ser pago, portanto nunca foi entregue) -- nao
-- precisa da mesma exclusao.
begin;

create or replace function public._apply_terminal_order_payment_status(p_payment_id uuid, p_target_status text)
returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_payment public.payments%rowtype;
  v_line record;
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
    -- 'delivered' fica de fora: produto ja entregue nunca tem sua reserva
    -- mexida, e o status permanece 'delivered' (fato fisico), nunca vira
    -- 'refunded' silenciosamente.
    for v_line in
      update public.order_items set status = 'refunded', reservation_expires_at = null, updated_at = now()
      where order_id = v_payment.order_id and status not in ('cancelled','expired','refunded','transferred','delivered')
      returning id, item_kind, store_item_id, store_item_variant_id, quantity
    loop
      if v_line.item_kind = 'product' then
        perform public.release_store_item_reservation(v_line.store_item_id, v_line.store_item_variant_id, v_line.quantity);
      end if;
    end loop;

    -- Cancela so tickets ATIVOS -- ticket ja usado preserva historico (nao e
    -- reaberto nem apagado; uma reversao de check-in e decisao administrativa
    -- separada). Ticket ja cancelado permanece cancelado.
    update public.tickets set status = 'cancelled', cancelled_at = now()
    where order_id = v_payment.order_id and status = 'active';

    update public.orders set status = 'refunded' where id = v_payment.order_id;
  else
    for v_line in
      update public.order_items set status = p_target_status, reservation_expires_at = null, updated_at = now()
      where order_id = v_payment.order_id and status = 'reserved'
      returning id, item_kind, store_item_id, store_item_variant_id, quantity
    loop
      if v_line.item_kind = 'product' then
        perform public.release_store_item_reservation(v_line.store_item_id, v_line.store_item_variant_id, v_line.quantity);
      end if;
    end loop;

    update public.orders set status = p_target_status where id = v_payment.order_id and status = 'pending';

    if p_target_status = 'expired' then
      -- Mesma vaga que get_event_ticket_categories() conta via
      -- participants.reservation_status -- sem isto a categoria fica
      -- "cheia" pra sempre mesmo com o pedido corretamente expirado.
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

-- remove_cart_order_item -- delega a release_store_item_reservation (o
-- mesmo helper que set_cart_order_item_quantity/890 ja usa) em vez de tocar
-- store_item_inventory direto, corrigindo o vazamento pra produto vinculado
-- a kit do evento (linked_event_kit_item_id, estoque real em
-- event_kit_item_variant_inventory) e eliminando a heuristica duplicada.
-- Nenhuma outra linha muda.
create or replace function public.remove_cart_order_item(p_order_item_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item nao encontrado.'; end if;
  if v_item.item_kind <> 'product' then raise exception 'Somente itens de produto podem ser removidos do carrinho por aqui.'; end if;
  select * into v_order from public.orders where id = v_item.order_id for update;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;
  if v_item.status = 'cancelled' then return jsonb_build_object('order_id', v_order.id, 'already_removed', true); end if;

  perform public.release_store_item_reservation(v_item.store_item_id, v_item.store_item_variant_id, v_item.quantity);

  update public.order_items set status = 'cancelled', discount_amount = 0, final_amount = 0, updated_at = now() where id = p_order_item_id;
  delete from public.order_item_discounts where order_item_id = p_order_item_id;

  perform public.apply_cart_coupon(v_order.id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_removed', 'orders', v_order.id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'order_item_id', p_order_item_id));

  return jsonb_build_object('order_id', v_order.id, 'removed', true);
end; $$;

commit;
