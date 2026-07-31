-- 043_create_confirm_order_item_and_issue_ticket.sql
-- Confirma um item específico do pedido e emite/reutiliza seu ingresso.

create or replace function public.confirm_order_item_and_issue_ticket(
  p_order_item_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_ticket_id uuid;
begin
  if p_order_item_id is null then
    raise exception 'Item do pedido obrigatorio.';
  end if;

  select *
  into v_item
  from public.order_items
  where id = p_order_item_id
  for update;

  if not found then
    raise exception 'Item do pedido nao encontrado.';
  end if;

  select *
  into v_order
  from public.orders
  where id = v_item.order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado para o item.';
  end if;

  select *
  into v_payment
  from public.payments
  where order_id = v_order.id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;

  if v_payment.payment_status <> 'paid' then
    raise exception 'Pagamento ainda nao confirmado.';
  end if;

  update public.order_items oi
  set
    status = 'confirmed',
    reservation_expires_at = null,
    updated_at = now()
  where oi.id = v_item.id;

  insert into public.tickets (
    order_id,
    order_item_id,
    participant_id,
    event_id,
    status
  ) values (
    v_order.id,
    v_item.id,
    v_item.participant_id,
    v_item.event_id,
    'active'
  )
  on conflict (order_item_id) where order_item_id is not null
  do update set
    order_id = excluded.order_id,
    participant_id = excluded.participant_id,
    event_id = excluded.event_id,
    status = 'active',
    cancelled_at = null,
    used_at = null
  returning id into v_ticket_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    'ticket_issued',
    'tickets',
    v_ticket_id,
    v_item.event_id,
    jsonb_build_object(
      'participant_id', v_item.participant_id,
      'order_id', v_order.id,
      'order_item_id', v_item.id,
      'payment_id', v_payment.id
    )
  );

  return v_ticket_id;
end;
$$;

grant execute on function public.confirm_order_item_and_issue_ticket(uuid)
to authenticated;

grant execute on function public.confirm_order_item_and_issue_ticket(uuid)
to anon;