-- FEATURE (5/10): confirmacao de pagamento (reserved -> confirmed) precisa
-- propagar pras unidades materializadas da linha, no mesmo momento em que
-- confirma a propria linha -- 3 RPCs redefinidas, corpo original
-- preservado, so a linha de cascata nova em cada uma:
--   1) confirm_order_item_and_issue_ticket (branch de produto) --
--      order_item_pickup_units;
--   2) confirm_store_order_payment (confirmacao administrativa) --
--      store_order_item_pickup_units;
--   3) simulate_store_order_payment (ferramenta de teste/simulacao pelo
--      proprio comprador) -- mesma cascata de (2).
begin;

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
  v_ticket_status text;
  v_ticket_inserted boolean;
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
  if v_item.item_kind = 'product' then
    update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now()
    where id=v_item.id;
    update public.order_item_pickup_units set status='confirmed', updated_at=now()
    where order_item_id=v_item.id and status='reserved';
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('order_item_product_confirmed','order_items',v_item.id,v_event.id,jsonb_build_object(
      'store_item_id',v_item.store_item_id,'order_id',v_order.id,'payment_id',v_payment.id,'organization_id',v_event.organization_id));
    return null;
  end if;

  -- Upsert do ticket ANTES de tocar o order_item: se o conflito revelar um
  -- ticket cancelado, o order_item fica intocado (nao ha "order_item
  -- confirmado com ticket cancelado" pendurado).
  insert into public.tickets(order_id,order_item_id,participant_id,event_id,organization_id,status)
  values(v_order.id,v_item.id,v_item.participant_id,v_event.id,v_event.organization_id,'active')
  on conflict(order_item_id) where order_item_id is not null do update set
    order_id=excluded.order_id,
    participant_id=excluded.participant_id,
    event_id=excluded.event_id,
    organization_id=excluded.organization_id
    -- status/cancelled_at/used_at deliberadamente NAO fazem parte do SET:
    -- no conflito, o ticket existente mantem seu status atual sempre.
  returning id, status, (xmax = 0) into v_ticket_id, v_ticket_status, v_ticket_inserted;

  if v_ticket_status = 'cancelled' then
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('ticket_reactivation_blocked','tickets',v_ticket_id,v_event.id,jsonb_build_object(
      'order_id',v_order.id,'order_item_id',v_item.id,'payment_id',v_payment.id,
      'organization_id',v_event.organization_id,'reason','ticket_ja_cancelado_administrativamente_ou_por_estorno'));
    return null;
  end if;

  update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now()
  where id=v_item.id;

  if v_ticket_inserted then
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('ticket_issued','tickets',v_ticket_id,v_event.id,jsonb_build_object(
      'participant_id',v_item.participant_id,'order_id',v_order.id,'order_item_id',v_item.id,
      'payment_id',v_payment.id,'organization_id',v_event.organization_id));
  end if;

  return v_ticket_id;
end; $$;

create or replace function public.confirm_store_order_payment(p_store_order_id uuid) returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_order public.store_orders%rowtype;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para confirmar pagamentos da lojinha.'; end if;
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_order.status = 'cancelled' then raise exception 'Pedido cancelado nao pode ser confirmado.'; end if;
  if v_order.status = 'confirmed' then return; end if;

  update public.store_orders set status = 'confirmed', payment_status = 'paid', confirmed_at = now(), updated_at = now() where id = p_store_order_id;
  update public.store_order_items set status = 'confirmed' where store_order_id = p_store_order_id and status = 'reserved';
  update public.store_order_item_pickup_units set status = 'confirmed', updated_at = now()
  where store_order_item_id in (select id from public.store_order_items where store_order_id = p_store_order_id) and status = 'reserved';
end; $$;

create or replace function public.simulate_store_order_payment(p_store_order_id uuid, p_payment_method text) returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_actor uuid := auth.uid(); v_order public.store_orders%rowtype;
begin
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if v_order.user_id <> v_actor then raise exception 'Sem permissao para confirmar este pedido.'; end if;
  if v_order.status = 'cancelled' then raise exception 'Pedido cancelado nao pode ser confirmado.'; end if;
  if v_order.status = 'confirmed' then return; end if;

  update public.store_orders set status = 'confirmed', payment_status = 'paid', payment_method = coalesce(p_payment_method, payment_method),
    paid_at = now(), confirmed_at = now(), updated_at = now()
  where id = p_store_order_id;
  update public.store_order_items set status = 'confirmed' where store_order_id = p_store_order_id and status = 'reserved';
  update public.store_order_item_pickup_units set status = 'confirmed', updated_at = now()
  where store_order_item_id in (select id from public.store_order_items where store_order_id = p_store_order_id) and status = 'reserved';
end; $$;

commit;
