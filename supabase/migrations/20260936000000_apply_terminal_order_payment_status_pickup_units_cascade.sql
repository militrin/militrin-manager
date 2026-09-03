-- FEATURE (8/10): _apply_terminal_order_payment_status (expiracao/
-- cancelamento/estorno de pagamento) passa a cancelar as unidades
-- pendentes das linhas de produto efetivamente revertidas. O caminho
-- 'refunded' tambem passa a EXCLUIR da reversao em massa qualquer linha
-- que ja tenha ALGUMA unidade entregue -- o status da propria linha so vira
-- 'delivered' quando TODAS as unidades sao entregues, entao uma entrega
-- parcial (modo per_unit) ficaria 'confirmed' e escaparia do filtro
-- anterior (que so excluia status='delivered' da linha inteira),
-- estornando um produto que na verdade ja foi parcialmente entregue.
--
-- O caminho 'expired'/'cancelled' so atinge status='reserved' -- pedido
-- nunca chegou a ser pago, portanto nenhuma unidade pode ter sido
-- promovida a 'confirmed' nem entregue; cascata sempre segura, sem
-- excecao adicional.
--
-- Redefinida a partir da versao vigente (20260926000000) -- corpo
-- original preservado, so as adicoes descritas acima.
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
    -- 'delivered' fica de fora, e agora tambem qualquer linha que ja tenha
    -- ALGUMA unidade entregue (per_unit parcial) -- o status da linha so
    -- vira 'delivered' quando TODAS as unidades sao entregues, entao uma
    -- entrega parcial ficaria 'confirmed' e escaparia do filtro anterior.
    for v_line in
      update public.order_items set status = 'refunded', reservation_expires_at = null, updated_at = now()
      where order_id = v_payment.order_id and status not in ('cancelled','expired','refunded','transferred','delivered')
        and not exists (select 1 from public.order_item_pickup_units u where u.order_item_id = order_items.id and u.status = 'delivered')
      returning id, item_kind, store_item_id, store_item_variant_id, quantity
    loop
      if v_line.item_kind = 'product' then
        perform public.release_store_item_reservation(v_line.store_item_id, v_line.store_item_variant_id, v_line.quantity);
        update public.order_item_pickup_units set status = 'cancelled', updated_at = now()
        where order_item_id = v_line.id and status <> 'delivered';
      end if;
    end loop;

    -- Cancela so tickets ATIVOS -- ticket ja usado preserva historico (nao e
    -- reaberto nem apagado; uma reversao de check-in e decisao administrativa
    -- separada). Ticket ja cancelado permanece cancelado.
    update public.tickets set status = 'cancelled', cancelled_at = now()
    where order_id = v_payment.order_id and status = 'active';

    update public.orders set status = 'refunded' where id = v_payment.order_id;
  else
    -- Este caminho so atinge status='reserved' -- pedido nunca chegou a ser
    -- pago, portanto nenhuma unidade pode ter sido promovida a 'confirmed'
    -- nem entregue. Cascata sempre segura, sem excecao.
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

commit;
