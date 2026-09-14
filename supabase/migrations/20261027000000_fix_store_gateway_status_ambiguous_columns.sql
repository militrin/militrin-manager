-- Hotfix: RETURNS TABLE(store_order_id, ...) colidia com
-- store_order_items.store_order_id (Postgres 42702 no ramo paid).
-- Sem mudanca de regra de negocio. Sem backfill. Sem UPDATE de dados.

create or replace function public.apply_store_order_gateway_status(
  p_provider text,
  p_provider_payment_id text,
  p_provider_status text,
  p_internal_status text,
  p_expected_gateway_account_key text default null,
  p_event_type text default null,
  p_external_reference text default null
)
returns table(store_order_id uuid, organization_id uuid, previous_status text, applied_status text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order public.store_orders%rowtype;
  v_expected text := nullif(trim(coalesce(p_expected_gateway_account_key, '')), '');
  v_event text := upper(trim(coalesce(p_event_type, '')));
  v_ext text := nullif(trim(coalesce(p_external_reference, '')), '');
  v_previous text;
  v_line record;
  v_matches integer;
  v_ext_uuid uuid;
begin
  if p_internal_status not in ('pending','processing','paid','expired','cancelled','refunded','chargeback','failed') then
    raise exception 'Status interno invalido: %', p_internal_status;
  end if;
  if nullif(trim(coalesce(p_provider_payment_id, '')), '') is null then
    raise exception 'provider_payment_id obrigatorio.';
  end if;

  select count(*) into v_matches
    from public.store_orders so
    where so.gateway_payment_id = p_provider_payment_id;
  if v_matches > 1 then
    raise exception using errcode = 'P0001', message = 'STORE_ORDER_AMBIGUOUS';
  end if;

  select so.* into v_order
    from public.store_orders so
    where so.gateway_payment_id = p_provider_payment_id
    for update;

  if not found and v_ext is not null then
    begin
      v_ext_uuid := v_ext::uuid;
    exception when invalid_text_representation then
      v_ext_uuid := null;
    end;
    if v_ext_uuid is not null then
      select so.* into v_order from public.store_orders so where so.id = v_ext_uuid for update;
    end if;
    if not found then
      select so.* into v_order from public.store_orders so where so.order_number = v_ext for update;
    end if;
    if found
      and v_order.gateway_payment_id is not null
      and v_order.gateway_payment_id is distinct from p_provider_payment_id then
      raise exception using errcode = 'P0001', message = 'STORE_ORDER_NOT_FOUND';
    end if;
  end if;

  if not found then
    raise exception using errcode = 'P0001', message = 'STORE_ORDER_NOT_FOUND';
  end if;

  if v_expected is not null
    and nullif(trim(coalesce(v_order.gateway_account_key, '')), '') is not null
    and v_order.gateway_account_key is distinct from v_expected then
    raise exception using errcode = 'P0001', message = 'GATEWAY_ACCOUNT_MISMATCH';
  end if;

  v_previous := v_order.payment_status;

  if v_event in ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED') then
    p_internal_status := 'refunded';
  end if;

  if v_event = 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED' then
    if v_order.status = 'pending' then
      update public.store_orders so
      set last_gateway_attempt_status = 'refused', updated_at = now()
      where so.id = v_order.id;
    end if;
    return query select v_order.id, v_order.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status in ('pending', 'processing', 'chargeback', 'failed') then
    return query select v_order.id, v_order.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status = 'paid' then
    if v_order.status = 'confirmed' or v_order.payment_status = 'paid' then
      return query select v_order.id, v_order.organization_id, v_previous, 'paid';
      return;
    end if;
    -- Cancelamento local (usuario/admin/refund) nao e revivido.
    -- Pedido expirado com dinheiro recebido: pagamento tem precedencia.
    if v_order.status = 'cancelled' then
      insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
      values (
        'store_order_paid_after_terminal',
        'store_orders',
        v_order.id,
        v_order.event_id,
        jsonb_build_object('provider', p_provider, 'provider_payment_id', p_provider_payment_id, 'status', v_order.status)
      );
      return query select v_order.id, v_order.organization_id, v_previous, v_previous;
      return;
    end if;

    update public.store_orders so set
      status = 'confirmed',
      payment_status = 'paid',
      paid_at = now(),
      confirmed_at = now(),
      last_gateway_attempt_status = null,
      gateway_payment_id = coalesce(so.gateway_payment_id, p_provider_payment_id),
      gateway_account_key = coalesce(so.gateway_account_key, v_expected),
      provider = coalesce(nullif(so.provider, 'fake'), p_provider, so.provider),
      updated_at = now()
    where so.id = v_order.id;
    update public.store_order_items soi set status = 'confirmed'
    where soi.store_order_id = v_order.id and soi.status = 'reserved';
    update public.store_order_item_pickup_units pu set status = 'confirmed', updated_at = now()
    where pu.store_order_item_id in (select soi.id from public.store_order_items soi where soi.store_order_id = v_order.id)
      and pu.status = 'reserved';
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_payment_confirmed',
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object(
        'provider', p_provider,
        'provider_payment_id', p_provider_payment_id,
        'event_type', nullif(v_event, ''),
        'external_reference', v_ext
      )
    );
    return query select v_order.id, v_order.organization_id, v_previous, 'paid';
    return;
  end if;

  if v_order.status = 'confirmed' or v_order.payment_status = 'paid' then
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_gateway_status_ignored',
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object('incoming', p_internal_status, 'provider_payment_id', p_provider_payment_id)
    );
    return query select v_order.id, v_order.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status in ('expired', 'cancelled', 'failed') and v_order.status = 'pending' then
    for v_line in
      select soi.* from public.store_order_items soi
      where soi.store_order_id = v_order.id and soi.status <> 'cancelled'
      for update
    loop
      perform public.release_store_item_reservation(v_line.store_item_id, v_line.variant_id, v_line.quantity);
      update public.store_order_items soi set status = 'cancelled' where soi.id = v_line.id;
      update public.store_order_item_pickup_units pu set status = 'cancelled', updated_at = now()
      where pu.store_order_item_id = v_line.id and pu.status <> 'delivered';
    end loop;

    update public.store_orders so set
      status = case when p_internal_status = 'expired' then 'expired' else 'cancelled' end,
      payment_status = 'cancelled',
      cancelled_at = now(),
      updated_at = now()
    where so.id = v_order.id;

    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_payment_'||p_internal_status,
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object('provider', p_provider, 'provider_payment_id', p_provider_payment_id)
    );
  elsif p_internal_status = 'refunded' then
    for v_line in
      select soi.* from public.store_order_items soi
      where soi.store_order_id = v_order.id and soi.status <> 'cancelled'
      for update
    loop
      if v_line.status in ('reserved', 'confirmed') then
        perform public.release_store_item_reservation(v_line.store_item_id, v_line.variant_id, v_line.quantity);
      end if;
      update public.store_order_items soi set status = 'cancelled' where soi.id = v_line.id and soi.status <> 'cancelled';
      update public.store_order_item_pickup_units pu set status = 'cancelled', updated_at = now()
      where pu.store_order_item_id = v_line.id and pu.status <> 'delivered';
    end loop;
    update public.store_orders so set
      status = 'cancelled',
      payment_status = 'refunded',
      cancelled_at = coalesce(so.cancelled_at, now()),
      updated_at = now()
    where so.id = v_order.id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_payment_refunded',
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object('provider', p_provider, 'provider_payment_id', p_provider_payment_id)
    );
  end if;

  return query
    select v_order.id, v_order.organization_id, v_previous,
      (select so.payment_status from public.store_orders so where so.id = v_order.id);
end;
$$;

comment on function public.apply_store_order_gateway_status(text, text, text, text, text, text, text) is
  'Aplica status de gateway a store_orders. Localiza por gateway_payment_id, depois externalReference (id ou order_number) e valida account key quando ambas existem. Confirma item/estoque/auditoria. Nao emite ingresso. Colunas SQL qualificas com alias para nao colidir com RETURNS TABLE.';
