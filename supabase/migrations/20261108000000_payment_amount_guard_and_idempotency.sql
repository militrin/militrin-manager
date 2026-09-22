-- P0 hardening: gateway amount gate, PIX retry idempotency, manual issue confirm.
-- Next version after 20261107. Local only in this round -- do not apply in production here.

begin;

create table if not exists public.manual_ticket_issue_requests (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  idempotency_key text not null,
  registration_contact_id uuid not null,
  event_id uuid not null,
  ticket_category_id uuid,
  ticket_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  unique (actor_user_id, idempotency_key)
);

alter table public.manual_ticket_issue_requests enable row level security;

drop index if exists public.ux_orders_user_client_request;
create unique index if not exists ux_orders_user_client_request_pending
  on public.orders (user_id, client_request_id)
  where client_request_id is not null and status = 'pending';

create or replace function public.find_recoverable_account_checkout_order_id(
  p_user_id uuid,
  p_event_id uuid,
  p_ticket_category_id uuid,
  p_quantity integer,
  p_payment_method text,
  p_coupon_code text,
  p_items jsonb,
  p_client_request_id text
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_request text := nullif(trim(coalesce(p_client_request_id, '')), '');
  v_method text := lower(trim(coalesce(p_payment_method, '')));
  v_coupon text := nullif(trim(coalesce(p_coupon_code, '')), '');
  v_item jsonb;
  v_index integer;
  v_preview numeric := 0;
  v_item_gender text;
  v_item_pricing record;
  v_existing_item public.order_items%rowtype;
  v_shirt_type text;
  v_shirt_size text;
  v_expires timestamptz;
begin
  if p_user_id is null or p_event_id is null then
    return null;
  end if;

  if v_request is not null then
    -- Intencao comercial identificada: so retoma o pedido pending com a mesma chave.
    -- Nao fundir checkouts deliberadamente distintos (client_request_id diferente)
    -- mesmo que o carrinho seja parecido.
    select o.* into v_order
    from public.orders o
    where o.user_id = p_user_id
      and o.client_request_id = v_request
      and o.event_id = p_event_id
      and o.status = 'pending'
    order by o.created_at desc
    limit 1;
  else
    -- Clientes antigos sem chave: retoma o pending recuperavel do mesmo carrinho.
    select o.* into v_order
    from public.orders o
    join public.payments pay on pay.order_id = o.id
    where o.user_id = p_user_id
      and o.event_id = p_event_id
      and o.status = 'pending'
      and lower(trim(coalesce(pay.payment_method, ''))) = v_method
      and pay.payment_status in ('pending', 'processing')
      and (
        select count(*) from public.order_items oi
        where oi.order_id = o.id and oi.status in ('reserved', 'confirmed')
      ) = p_quantity
      and (
        p_ticket_category_id is null
        or exists (
          select 1 from public.order_items oi
          where oi.order_id = o.id
            and oi.ticket_category_id is not distinct from p_ticket_category_id
        )
      )
    order by o.created_at desc
    limit 1;
  end if;

  if v_order.id is null then
    return null;
  end if;

  select * into v_payment
  from public.payments
  where order_id = v_order.id
  order by created_at desc
  limit 1;
  if not found then
    return null;
  end if;
  if v_order.status <> 'pending' or v_payment.payment_status not in ('pending', 'processing') then
    return null;
  end if;
  if lower(trim(coalesce(v_payment.payment_method, ''))) is distinct from v_method then
    return null;
  end if;

  v_expires := coalesce(v_payment.expires_at, v_order.created_at + interval '2 hours');
  if v_expires is not null and v_expires <= now() then
    return null;
  end if;

  if (
    select count(*) from public.order_items oi
    where oi.order_id = v_order.id and oi.status in ('reserved', 'confirmed')
  ) is distinct from p_quantity then
    return null;
  end if;

  for v_index in 1..coalesce(p_quantity, 0) loop
    v_item := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;
    select * into v_existing_item
    from public.order_items
    where order_id = v_order.id and item_position = v_index
    limit 1;
    if not found then
      return null;
    end if;
    if v_existing_item.ticket_category_id is distinct from p_ticket_category_id then
      return null;
    end if;
    v_shirt_type := nullif(trim(coalesce(v_item ->> 'shirt_type', '')), '');
    v_shirt_size := nullif(trim(coalesce(v_item ->> 'shirt_size', '')), '');
    if v_shirt_type is not null and v_existing_item.shirt_type is distinct from v_shirt_type then
      return null;
    end if;
    if v_shirt_size is not null and v_existing_item.shirt_size is distinct from v_shirt_size then
      return null;
    end if;
    v_item_gender := nullif(trim(coalesce(v_item ->> 'pricing_gender', '')), '');
    select * into v_item_pricing
    from public.get_registration_pricing_preview(
      coalesce(v_item_gender, v_existing_item.pricing_gender),
      v_coupon,
      p_event_id,
      p_ticket_category_id
    )
    limit 1;
    if v_item_pricing.batch_id is null then
      return null;
    end if;
    if round(coalesce(v_item_pricing.final_amount, 0), 2) is distinct from round(coalesce(v_existing_item.final_amount, 0), 2) then
      return null;
    end if;
    if v_item_pricing.batch_id is distinct from v_existing_item.batch_id then
      return null;
    end if;
    v_preview := v_preview + coalesce(v_item_pricing.final_amount, 0);
  end loop;

  if round(v_preview, 2) is distinct from round(coalesce(v_order.final_amount, 0), 2) then
    return null;
  end if;

  return v_order.id;
end;
$$;

revoke all on function public.find_recoverable_account_checkout_order_id(uuid, uuid, uuid, integer, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.find_recoverable_account_checkout_order_id(uuid, uuid, uuid, integer, text, text, jsonb, text)
  to authenticated, service_role;

create or replace function public.record_unpersisted_gateway_charge(
  p_order_id uuid,
  p_provider text,
  p_gateway_payment_id text,
  p_gateway_account_key text default null,
  p_cancelled boolean default false,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_payment public.payments%rowtype;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;
  select * into v_payment
  from public.payments
  where order_id = p_order_id
  order by created_at desc
  limit 1
  for update;
  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;
  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.user_id = v_actor
  ) then
    raise exception 'Sem acesso a este pedido.';
  end if;
  if v_payment.payment_status in ('paid', 'refunded') then
    return;
  end if;
  update public.payments
  set
    provider = coalesce(nullif(trim(coalesce(p_provider, '')), ''), provider),
    gateway_payment_id = case
      when coalesce(p_cancelled, false) then gateway_payment_id
      else coalesce(gateway_payment_id, nullif(trim(coalesce(p_gateway_payment_id, '')), ''))
    end,
    gateway_account_key = coalesce(gateway_account_key, nullif(trim(coalesce(p_gateway_account_key, '')), '')),
    last_gateway_attempt_status = case when coalesce(p_cancelled, false) then 'pix_qr_failed' else 'pix_qr_failed_orphaned' end,
    updated_at = now()
  where id = v_payment.id;
  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    case when coalesce(p_cancelled, false) then 'payment_pix_qr_failed_cancelled' else 'payment_pix_qr_failed_orphaned' end,
    'payments',
    v_payment.id,
    v_payment.event_id,
    jsonb_build_object(
      'order_id', p_order_id,
      'provider', p_provider,
      'gateway_payment_id', p_gateway_payment_id,
      'cancelled', coalesce(p_cancelled, false),
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );
end;
$$;

revoke all on function public.record_unpersisted_gateway_charge(uuid, text, text, text, boolean, text)
  from public, anon;
grant execute on function public.record_unpersisted_gateway_charge(uuid, text, text, text, boolean, text)
  to authenticated, service_role;


drop function if exists public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric, text, text);
create or replace function public.apply_gateway_payment_status(
  p_provider text,
  p_provider_payment_id text,
  p_provider_status text,
  p_internal_status text,
  p_paid_at timestamptz default null,
  p_fee_amount numeric default null,
  p_net_amount numeric default null,
  p_expected_gateway_account_key text default null,
  p_event_type text default null,
  p_gateway_amount numeric default null
)
returns table(payment_id uuid, order_id uuid, organization_id uuid, previous_status text, applied_status text)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment public.payments%rowtype;
  v_charge public.payment_gateway_charges%rowtype;
  v_previous text;
  v_applied text;
  v_expected_key text := nullif(trim(coalesce(p_expected_gateway_account_key, '')), '');
  v_event text := upper(trim(coalesce(p_event_type, '')));
  v_has_charge boolean := false;
  v_expected_amount numeric;
  v_gateway_amount numeric;
begin
  if p_internal_status not in ('pending','processing','paid','expired','cancelled','refunded','chargeback','failed') then
    raise exception 'Status interno invalido: %', p_internal_status;
  end if;
  if nullif(trim(coalesce(p_provider_payment_id,'')),'') is null then
    raise exception 'provider_payment_id obrigatorio.';
  end if;

  if v_expected_key is not null then
    select * into v_charge
    from public.payment_gateway_charges
    where provider = p_provider
      and gateway_payment_id = p_provider_payment_id
      and coalesce(gateway_account_key, '') = v_expected_key
    order by created_at
    limit 1
    for update;
    v_has_charge := found;

    if not v_has_charge and exists (
      select 1 from public.payment_gateway_charges
      where provider = p_provider
        and gateway_payment_id = p_provider_payment_id
    ) then
      raise exception using errcode='P0001', message='GATEWAY_ACCOUNT_MISMATCH',
        detail=jsonb_build_object('code','GATEWAY_ACCOUNT_MISMATCH','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
    end if;
  else
    select * into v_charge
    from public.payment_gateway_charges
    where provider = p_provider
      and gateway_payment_id = p_provider_payment_id
    order by created_at
    limit 1
    for update;
    v_has_charge := found;
  end if;

  if v_has_charge then
    select * into v_payment from public.payments where id = v_charge.payment_id for update;
    if not found then
      raise exception using errcode='P0001', message='PAYMENT_NOT_FOUND',
        detail=jsonb_build_object('code','PAYMENT_NOT_FOUND','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
    end if;
    if v_expected_key is not null then
      if v_payment.gateway_account_key is not null
        and v_payment.gateway_account_key is distinct from v_expected_key then
        raise exception using errcode='P0001', message='GATEWAY_ACCOUNT_MISMATCH',
          detail=jsonb_build_object('code','GATEWAY_ACCOUNT_MISMATCH','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
      end if;
    end if;
    if v_payment.gateway_payment_id is null
      or not v_charge.reusable
      or v_charge.deleted
      or (
        v_payment.gateway_payment_id is distinct from p_provider_payment_id
        and (
          v_payment.gateway_installment_id is null
          or v_charge.gateway_installment_id is null
          or v_payment.gateway_installment_id is distinct from v_charge.gateway_installment_id
        )
      ) then
      raise exception using errcode='P0001', message='PAYMENT_NOT_FOUND',
        detail=jsonb_build_object('code','PAYMENT_NOT_FOUND','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
    end if;
  else
    if v_expected_key is not null then
      select * into v_payment
      from public.payments
      where provider = p_provider
        and gateway_payment_id = p_provider_payment_id
        and coalesce(gateway_account_key, '') = v_expected_key
      for update;

      if not found then
        if exists (
          select 1 from public.payments
          where provider = p_provider and gateway_payment_id = p_provider_payment_id
        ) then
          raise exception using errcode='P0001', message='GATEWAY_ACCOUNT_MISMATCH',
            detail=jsonb_build_object('code','GATEWAY_ACCOUNT_MISMATCH','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
        end if;
        raise exception using errcode='P0001', message='PAYMENT_NOT_FOUND',
          detail=jsonb_build_object('code','PAYMENT_NOT_FOUND','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
      end if;
    else
      select * into v_payment
      from public.payments
      where provider = p_provider and gateway_payment_id = p_provider_payment_id
      for update;
      if not found then
        raise exception using errcode='P0001', message='PAYMENT_NOT_FOUND',
          detail=jsonb_build_object('code','PAYMENT_NOT_FOUND','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
      end if;
    end if;
  end if;

  v_previous := v_payment.payment_status;

  if v_event in ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED') then
    p_internal_status := 'refunded';
    if coalesce(upper(trim(p_provider_status)), '') in ('', 'RECEIVED', 'CONFIRMED', 'PENDING', 'RECEIVED_IN_CASH') then
      p_provider_status := case when v_event = 'PAYMENT_REFUNDED' then 'REFUNDED' else 'PARTIALLY_REFUNDED' end;
    end if;
  end if;

  if v_has_charge then
    if v_event = 'PAYMENT_DELETED' or p_internal_status in ('cancelled', 'expired') then
      update public.payment_gateway_charges
      set gateway_status = coalesce(p_provider_status, gateway_status),
          deleted = (v_event = 'PAYMENT_DELETED' or p_internal_status = 'cancelled'),
          reusable = false,
          updated_at = now()
      where id = v_charge.id;
    else
      update public.payment_gateway_charges
      set gateway_status = coalesce(p_provider_status, gateway_status),
          updated_at = now()
      where id = v_charge.id;
    end if;
  end if;

  if v_event = 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED' then
    if v_previous = 'pending' then
      update public.payments
      set last_gateway_attempt_status = 'refused',
          provider_status = p_provider_status,
          updated_at = now()
      where id = v_payment.id;
      insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
      values (
        'payment_card_capture_refused',
        'payments',
        v_payment.id,
        v_payment.event_id,
        jsonb_build_object(
          'provider', p_provider,
          'provider_payment_id', p_provider_payment_id,
          'provider_status', p_provider_status,
          'order_id', v_payment.order_id
        )
      );
    end if;
    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
    return;
  end if;

  if v_event = 'PAYMENT_DELETED' then
    update public.payments
    set provider_status = coalesce(p_provider_status, provider_status),
        updated_at = now()
    where id = v_payment.id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'payment_gateway_charge_deleted',
      'payments',
      v_payment.id,
      v_payment.event_id,
      jsonb_build_object(
        'provider', p_provider,
        'provider_payment_id', p_provider_payment_id,
        'order_id', v_payment.order_id
      )
    );
    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status in ('processing','chargeback','failed') then
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('payment_gateway_signal_'||p_internal_status,'payments',v_payment.id,v_payment.event_id,
      jsonb_build_object('provider',p_provider,'provider_payment_id',p_provider_payment_id,'provider_status',p_provider_status,'order_id',v_payment.order_id));
    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status = 'pending' then
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
    return;
  end if;

  if p_internal_status = 'paid' then
    if v_previous = 'paid' then
      update public.payments
      set provider_status = p_provider_status,
          last_gateway_attempt_status = null,
          updated_at = now()
      where id = v_payment.id;
      return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, 'paid';
      return;
    end if;

    v_expected_amount := round(coalesce(
      case when v_has_charge then v_charge.amount else null end,
      v_payment.final_amount,
      0
    ), 2);
    v_gateway_amount := case when p_gateway_amount is null then null else round(p_gateway_amount, 2) end;
    if v_expected_amount <= 0
      or v_gateway_amount is null
      or v_gateway_amount <= 0
      or v_gateway_amount is distinct from v_expected_amount then
      insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
      values (
        'payment_gateway_amount_mismatch',
        'payments',
        v_payment.id,
        v_payment.event_id,
        jsonb_build_object(
          'provider', p_provider,
          'provider_payment_id', p_provider_payment_id,
          'provider_status', p_provider_status,
          'event_type', nullif(v_event, ''),
          'order_id', v_payment.order_id,
          'expected_amount', v_expected_amount,
          'gateway_amount', v_gateway_amount,
          'previous_status', v_previous
        )
      );
      return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_previous;
      return;
    end if;

    update public.payments set
      payment_status = 'paid',
      provider_status = p_provider_status,
      last_gateway_attempt_status = null,
      paid_at = coalesce(p_paid_at, now()),
      fee_amount = coalesce(p_fee_amount, fee_amount),
      net_amount = coalesce(p_net_amount, net_amount),
      expires_at = null,
      updated_at = now()
    where id = v_payment.id;

    if v_previous <> 'pending' then
      insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
      values('payment_paid_after_'||v_previous,'payments',v_payment.id,v_payment.event_id,
        jsonb_build_object('provider',p_provider,'provider_payment_id',p_provider_payment_id,'order_id',v_payment.order_id,
          'previous_status',v_previous,'needs_manual_reconciliation',true));
      return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, 'paid';
      return;
    end if;

    if v_payment.order_id is not null then
      perform public.confirm_order_payment_and_issue_tickets(v_payment.order_id);
    end if;

    return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, 'paid';
    return;
  end if;

  if v_previous = 'paid' and p_internal_status = 'refunded' then
    perform public._apply_terminal_order_payment_status(v_payment.id, 'refunded');
    perform public.finalize_payment_refund_side_effects(v_payment.id);
  elsif v_previous = 'refunded' and p_internal_status = 'refunded' then
    update public.payments set provider_status = p_provider_status, refund_status = 'completed', updated_at = now() where id = v_payment.id;
    perform public.finalize_payment_refund_side_effects(v_payment.id);
  elsif v_previous = 'pending' then
    perform public._apply_terminal_order_payment_status(v_payment.id, p_internal_status);
  elsif v_previous = p_internal_status then
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
  else
    update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('payment_gateway_status_conflict_ignored','payments',v_payment.id,v_payment.event_id,
      jsonb_build_object('provider',p_provider,'provider_payment_id',p_provider_payment_id,'order_id',v_payment.order_id,
        'previous_status',v_previous,'incoming_status',p_internal_status));
  end if;

  select payment_status into v_applied from public.payments where id = v_payment.id;
  return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, v_applied;
end;
$$;

revoke all on function public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric, text, text, numeric)
from public, anon, authenticated;
grant execute on function public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric, text, text, numeric)
to service_role;

drop function if exists public.apply_store_order_gateway_status(text, text, text, text, text, text, text);
create or replace function public.apply_store_order_gateway_status(
  p_provider text,
  p_provider_payment_id text,
  p_provider_status text,
  p_internal_status text,
  p_expected_gateway_account_key text default null,
  p_event_type text default null,
  p_external_reference text default null,
  p_gateway_amount numeric default null
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
  v_expected_amount numeric;
  v_gateway_amount numeric;
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
    v_expected_amount := round(coalesce(v_order.final_amount, 0), 2);
    v_gateway_amount := case when p_gateway_amount is null then null else round(p_gateway_amount, 2) end;
    if v_expected_amount <= 0
      or v_gateway_amount is null
      or v_gateway_amount <= 0
      or v_gateway_amount is distinct from v_expected_amount then
      insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
      values (
        'store_order_gateway_amount_mismatch',
        'store_orders',
        v_order.id,
        v_order.event_id,
        jsonb_build_object(
          'provider', p_provider,
          'provider_payment_id', p_provider_payment_id,
          'expected_amount', v_expected_amount,
          'gateway_amount', v_gateway_amount,
          'previous_status', v_previous
        )
      );
      return query select v_order.id, v_order.organization_id, v_previous, v_previous;
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

revoke all on function public.apply_store_order_gateway_status(text, text, text, text, text, text, text, numeric)
from public, anon, authenticated;
grant execute on function public.apply_store_order_gateway_status(text, text, text, text, text, text, text, numeric)
to service_role;

create or replace function public.create_multi_ticket_order_checkout(
  p_event_id uuid,p_ticket_category_id uuid,p_gender text,p_quantity integer,p_payment_method text,
  p_coupon_code text default null,p_shirt_type text default null,p_shirt_size text default null,
  p_buyer_full_name text default null,p_buyer_cpf text default null,p_buyer_birth_date date default null,
  p_buyer_gender text default null,p_buyer_phone text default null,p_buyer_email text default null,p_buyer_city text default null,
  p_assign_first_to_buyer boolean default true,p_items jsonb default '[]'::jsonb,p_limit_per_order integer default 10,
  p_notes text default null,p_client_request_id text default null
) returns table(order_id uuid,payment_id uuid,order_number text,payment_status text,reservation_expires_at timestamptz,
  item_count integer,amount numeric,discount_amount numeric,final_amount numeric)
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_result record;
  v_user uuid := auth.uid();
  v_resume uuid;
  v_request text := nullif(trim(coalesce(p_client_request_id, '')), '');
  v_inner_request text;
  v_resume_order_id uuid;
  v_resume_payment_id uuid;
  v_resume_order_number text;
  v_resume_payment_status text;
  v_resume_expires timestamptz;
  v_resume_item_count integer;
  v_resume_amount numeric;
  v_resume_discount numeric;
  v_resume_final numeric;
begin
  if v_user is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      v_user::text || ':checkout:' || coalesce(p_event_id::text, '') || ':' || coalesce(p_ticket_category_id::text, '') || ':' || coalesce(p_quantity, 0)::text,
      0
    ));
  end if;

  v_resume := public.find_recoverable_account_checkout_order_id(
    v_user,
    p_event_id,
    p_ticket_category_id,
    p_quantity,
    p_payment_method,
    p_coupon_code,
    p_items,
    v_request
  );

  if v_resume is not null then
    select
      o.id,
      pay.id,
      o.order_number,
      coalesce(pay.payment_status, 'pending'),
      pay.expires_at,
      coalesce((select count(*)::integer from public.order_items oi where oi.order_id = o.id), 0),
      coalesce(pay.amount, o.base_amount, 0),
      coalesce(pay.discount_amount, o.discount_amount, 0),
      coalesce(pay.final_amount, o.final_amount, 0)
    into
      v_resume_order_id,
      v_resume_payment_id,
      v_resume_order_number,
      v_resume_payment_status,
      v_resume_expires,
      v_resume_item_count,
      v_resume_amount,
      v_resume_discount,
      v_resume_final
    from public.orders o
    left join public.payments pay on pay.order_id = o.id
    where o.id = v_resume
    order by pay.created_at desc
    limit 1;
    return query select
      v_resume_order_id, v_resume_payment_id, v_resume_order_number, v_resume_payment_status, v_resume_expires,
      v_resume_item_count, v_resume_amount, v_resume_discount, v_resume_final;
    return;
  end if;

  -- Inner checkout still reuses ANY order with the same client_request_id,
  -- including expired/cancelled. If that key is occupied by a non-recoverable
  -- order, mint a fresh key so we create a new pending instead of resuming it.
  v_inner_request := v_request;
  if v_request is not null and exists (
    select 1 from public.orders o
    where o.user_id = v_user and o.client_request_id = v_request
  ) then
    update public.orders
    set client_request_id = client_request_id || '#retired#' || id::text
    where user_id = v_user
      and client_request_id = v_request
      and status = 'pending';
    v_inner_request := v_request || '#n#' || gen_random_uuid()::text;
  end if;

  select * into v_result from public.create_multi_ticket_order_checkout_inventory_legacy(
    p_event_id,p_ticket_category_id,p_gender,p_quantity,p_payment_method,p_coupon_code,p_shirt_type,p_shirt_size,
    p_buyer_full_name,p_buyer_cpf,p_buyer_birth_date,p_buyer_gender,p_buyer_phone,p_buyer_email,p_buyer_city,
    p_assign_first_to_buyer,p_items,p_limit_per_order,p_notes,v_inner_request) limit 1;
  perform public.materialize_self_checkout_holder(v_result.order_id,p_assign_first_to_buyer,p_buyer_cpf,
    p_buyer_full_name,p_buyer_birth_date,p_buyer_gender,p_buyer_phone,p_buyer_email,p_buyer_city);
  perform public.materialize_named_checkout_holders(v_result.order_id,p_items);
  return query select v_result.order_id,v_result.payment_id,v_result.order_number,v_result.payment_status,
    v_result.reservation_expires_at,v_result.item_count,v_result.amount,v_result.discount_amount,v_result.final_amount;
end; $$;

revoke all on function public.create_multi_ticket_order_checkout(
  uuid,uuid,text,integer,text,text,text,text,text,text,date,text,text,text,text,boolean,jsonb,integer,text,text
) from public,anon,authenticated;
grant execute on function public.create_multi_ticket_order_checkout(
  uuid,uuid,text,integer,text,text,text,text,text,text,date,text,text,text,text,boolean,jsonb,integer,text,text
) to authenticated;

create or replace function public.simulate_fake_gateway_payment_paid(p_order_id uuid)
returns table(payment_id uuid, order_id uuid, organization_id uuid, applied_status text)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  if v_actor is null then raise exception 'Usuario autenticado obrigatorio.'; end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  -- Qualificado explicitamente (public.payments.order_id): RETURNS TABLE(...,
  -- order_id uuid, ...) declara "order_id" como variavel PL/pgSQL no escopo
  -- desta funcao, entao uma referencia solta a coluna order_id aqui seria
  -- ambigua entre a coluna da tabela e essa variavel de saida.
  select * into v_payment from public.payments where public.payments.order_id = p_order_id order by created_at desc limit 1;
  if not found then raise exception 'Pagamento nao encontrado para o pedido.'; end if;

  -- Defesa em profundidade: a validacao real de "isto e o provider fake" e
  -- aqui, contra o que esta de fato gravado no pagamento -- nunca confia em
  -- NODE_ENV, em uma flag do cliente, ou na variavel de ambiente do
  -- processo que chamou esta funcao.
  if v_payment.provider is distinct from 'fake' then
    raise exception using errcode='P0001', message='SIMULATION_NOT_ALLOWED',
      detail=jsonb_build_object('code','SIMULATION_NOT_ALLOWED','message','Simulacao de pagamento so e permitida quando o provider da cobranca e fake.')::text;
  end if;
  if v_payment.gateway_payment_id is null then
    raise exception 'Nenhuma cobranca PIX foi gerada para este pedido ainda.';
  end if;

  return query
  select g.payment_id, g.order_id, g.organization_id, g.applied_status
  from public.apply_gateway_payment_status(
    'fake', v_payment.gateway_payment_id, 'SIMULATED_CONFIRMED', 'paid',
    now(), null, null, null, null, v_payment.final_amount
  ) g;
end;
$$;

create or replace function public.trg_ticket_copy_intended_owner()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- intended_owner e destino de propriedade, nunca sinonimo de titular.
  if new.intended_owner_contact_id is null then
    new.intended_owner_contact_id := nullif(current_setting('app.administrative_intended_owner_contact_id', true), '')::uuid;
  end if;
  if new.intended_owner_contact_id is null and new.order_item_id is not null then
    select oi.intended_owner_contact_id
      into new.intended_owner_contact_id
    from public.order_items oi
    where oi.id = new.order_item_id;
  end if;
  return new;
end;
$$;

drop function if exists public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text);
drop function if exists public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean);
create or replace function public.issue_manual_ticket_batch(
  p_registration_contact_id uuid, p_event_id uuid, p_ticket_category_id uuid, p_batch_id uuid, p_quantity integer,
  p_pricing_gender text, p_shirt_type text, p_shirt_size text, p_payment_method text, p_notes text default null,
  p_assign_holder boolean default true,
  p_acknowledge_existing boolean default false,
  p_idempotency_key text default null
) returns table(ticket_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_contact public.registration_contacts%rowtype;
  v_event_organization_id uuid;
  v_first record;
  v_extra record;
  v_index integer;
  v_owner_user_id uuid;
  v_issue_reason text := lower(trim(coalesce(p_payment_method, '')));
  v_financial_method constant text := 'courtesy';
  v_idempotency_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_existing_ticket record;
  v_existing_code text;
  v_replay uuid[];
  v_issued uuid[] := '{}'::uuid[];
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    v_actor::text || ':manual-issue:' || coalesce(p_registration_contact_id::text, '') || ':' || coalesce(p_event_id::text, ''),
    0
  ));
  if v_idempotency_key is not null then
    select ticket_ids into v_replay
    from public.manual_ticket_issue_requests
    where actor_user_id = v_actor
      and idempotency_key = v_idempotency_key;
    if found then
      foreach ticket_id in array coalesce(v_replay, '{}'::uuid[]) loop
        return next;
      end loop;
      return;
    end if;
  end if;
  if v_issue_reason not in ('courtesy', 'system_failure', 'administrative_correction', 'other') then
    raise exception 'Motivo de emissao manual invalido.';
  end if;
  if v_issue_reason = 'other' and nullif(trim(coalesce(p_notes, '')), '') is null then
    raise exception 'Descreva o motivo da emissao manual.';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    raise exception 'Quantidade deve estar entre 1 e 20.';
  end if;
  select organization_id into v_event_organization_id from public.events where id = p_event_id;
  if v_event_organization_id is null then raise exception 'Evento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_event_organization_id) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;
  select * into v_contact from public.registration_contacts
  where id = p_registration_contact_id and organization_id = v_event_organization_id;
  if not found then raise exception 'Cadastro nao pertence a organizacao do evento.'; end if;
  select
    t.id,
    t.status,
    o.display_number,
    o.order_number,
    oi.item_position
  into v_existing_ticket
  from public.tickets t
  join public.order_items oi on oi.id = t.order_item_id
  join public.orders o on o.id = t.order_id
  where t.event_id = p_event_id
    and t.status in ('active', 'used')
    and (
      oi.registration_contact_id = v_contact.id
      or t.intended_owner_contact_id = v_contact.id
      or exists (
        select 1 from public.participants p
        where p.id = t.participant_id
          and p.registration_contact_id = v_contact.id
      )
    )
    and (p_ticket_category_id is null or oi.ticket_category_id is not distinct from p_ticket_category_id)
  order by t.issued_at desc nulls last, t.id desc
  limit 1;
  if found and coalesce(p_acknowledge_existing, false) is not true then
    v_existing_code := coalesce(
      '#' || lpad(coalesce(v_existing_ticket.display_number::text, '0'), 6, '0')
        || '-' || lpad(coalesce(v_existing_ticket.item_position::text, '1'), 2, '0'),
      v_existing_ticket.order_number
    );
    raise exception using errcode = 'P0001',
      message = 'EXISTING_OPERATIONAL_TICKET',
      detail = jsonb_build_object(
        'code', 'EXISTING_OPERATIONAL_TICKET',
        'ticket_id', v_existing_ticket.id,
        'ticket_status', v_existing_ticket.status,
        'ticket_code', v_existing_code,
        'message', format(
          'Esta pessoa já possui um ingresso ativo/usado para este evento. Ingresso existente: %s. Deseja realmente emitir outro ingresso?',
          v_existing_code
        )
      )::text;
  end if;
  perform set_config('app.administrative_ticket_issue_actor', v_actor::text, true);
  perform set_config('app.administrative_intended_owner_contact_id', v_contact.id::text, true);

  if coalesce(p_assign_holder, true) then
    perform public.assert_ticket_holder_contact_available(null, p_event_id, v_contact.id);
    select * into v_first from public.create_manual_registration_order(
      p_event_id, p_ticket_category_id, p_batch_id, v_contact.full_name, v_contact.cpf, v_contact.birth_date,
      p_pricing_gender, v_contact.phone, v_contact.email, v_contact.city, p_shirt_type, p_shirt_size, v_financial_method, p_notes);
    update public.participants
    set registration_contact_id = v_contact.id,
        user_id = case when user_id is null then v_contact.user_id else user_id end
    where id = v_first.participant_id;
    if not found then raise exception 'Falha ao vincular participante ao cadastro.'; end if;
    update public.order_items
    set registration_contact_id = v_contact.id,
        intended_owner_contact_id = v_contact.id
    where id = v_first.order_item_id;
    if not found then raise exception 'Falha ao vincular item ao cadastro.'; end if;
    update public.tickets
    set intended_owner_contact_id = v_contact.id
    where id = v_first.ticket_id;
    if v_contact.user_id is not null then
      perform public.materialize_intended_ticket_owners_for_contact(v_contact.id, v_contact.user_id);
    end if;
    v_owner_user_id := public.resolve_administrative_ticket_owner(v_event_organization_id, v_contact.id);
    update public.tickets
    set owner_user_id = v_owner_user_id
    where id = v_first.ticket_id
      and owner_user_id is null
      and v_owner_user_id is not null;
    if v_owner_user_id is not null and not exists (
      select 1 from public.ticket_owner_history h where h.ticket_id = v_first.ticket_id
    ) then
      insert into public.ticket_owner_history (
        ticket_id, order_id, event_id, organization_id, operation,
        previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
      )
      values (
        v_first.ticket_id, v_first.order_id, p_event_id, v_event_organization_id, 'owner_assigned',
        null, v_owner_user_id, v_actor, 'data_regularization',
        'Propriedade materializada na emissao administrativa para Pessoa com conta vinculada.'
      );
    end if;
    perform public.ensure_ticket_kit_items(v_first.ticket_id);
    perform public.assert_administrative_destination_ownership(v_first.ticket_id, v_contact.id);
    ticket_id := v_first.ticket_id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values ('manual_ticket_issued', 'tickets', ticket_id, p_event_id, jsonb_build_object(
      'actor_user_id', v_actor, 'registration_contact_id', v_contact.id, 'order_id', v_first.order_id,
      'order_item_id', v_first.order_item_id, 'issue_reason', v_issue_reason,
      'reason_text', nullif(trim(coalesce(p_notes, '')), ''), 'payment_method', v_financial_method,
      'assign_holder', true, 'owner_user_id', v_owner_user_id, 'buyer_type', 'administrative',
      'organization_id', v_event_organization_id, 'intended_owner_contact_id', v_contact.id));
    v_issued := array_append(v_issued, ticket_id);
    return next;
    v_index := 2;
  else
    v_index := 1;
  end if;

  v_owner_user_id := public.resolve_administrative_ticket_owner(v_event_organization_id, v_contact.id);

  for v_index in v_index..p_quantity loop
    select * into v_extra from public.create_manual_unassigned_ticket_order(
      p_event_id, p_ticket_category_id, p_batch_id, p_pricing_gender, p_shirt_type, p_shirt_size, v_financial_method, p_notes);
    update public.order_items
    set intended_owner_contact_id = coalesce(intended_owner_contact_id, v_contact.id)
    where id = v_extra.order_item_id;
    update public.tickets
    set
      owner_user_id = coalesce(v_owner_user_id, owner_user_id),
      intended_owner_contact_id = coalesce(intended_owner_contact_id, v_contact.id)
    where id = v_extra.ticket_id;
    if v_owner_user_id is not null and not exists (
      select 1 from public.ticket_owner_history h where h.ticket_id = v_extra.ticket_id
    ) then
      insert into public.ticket_owner_history (
        ticket_id, order_id, event_id, organization_id, operation,
        previous_owner_user_id, new_owner_user_id, actor_user_id, reason_code, reason_text
      )
      values (
        v_extra.ticket_id, v_extra.order_id, p_event_id, v_event_organization_id, 'owner_assigned',
        null, v_owner_user_id, v_actor, 'data_regularization',
        'Propriedade materializada na emissao sem titular para conta de destino.'
      );
    end if;
    perform public.ensure_ticket_kit_items(v_extra.ticket_id);
    perform public.assert_administrative_destination_ownership(v_extra.ticket_id, v_contact.id);
    ticket_id := v_extra.ticket_id;
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values ('manual_ticket_issued', 'tickets', ticket_id, p_event_id, jsonb_build_object(
      'actor_user_id', v_actor, 'registration_contact_id', v_contact.id, 'order_id', v_extra.order_id,
      'order_item_id', v_extra.order_item_id, 'issue_reason', v_issue_reason,
      'reason_text', nullif(trim(coalesce(p_notes, '')), ''), 'payment_method', v_financial_method,
      'assign_holder', false, 'owner_user_id', v_owner_user_id, 'buyer_type', 'administrative',
      'organization_id', v_event_organization_id, 'holder_assigned', false,
      'intended_owner_contact_id', v_contact.id));
    v_issued := array_append(v_issued, ticket_id);
    return next;
  end loop;
  if v_idempotency_key is not null then
    insert into public.manual_ticket_issue_requests(actor_user_id, idempotency_key, registration_contact_id, event_id, ticket_category_id, ticket_ids)
    values (v_actor, v_idempotency_key, v_contact.id, p_event_id, p_ticket_category_id, v_issued)
    on conflict (actor_user_id, idempotency_key) do nothing;
  end if;
end;
$$;

revoke all on function public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.issue_manual_ticket_batch(uuid, uuid, uuid, uuid, integer, text, text, text, text, text, boolean, boolean, text)
  to authenticated;

commit;

