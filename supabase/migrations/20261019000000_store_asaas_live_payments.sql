-- Loja: persistir provider/account key/ambiente da cobranca Asaas,
-- confirmar/expirar via webhook, e liberar reserva de pedidos PIX fake
-- quando expires_at vencer. Nao marca #001622 como pago.
begin;

alter table public.store_orders
  add column if not exists provider text,
  add column if not exists gateway_account_key text,
  add column if not exists gateway_environment text,
  add column if not exists gateway_checkout_url text,
  add column if not exists last_gateway_attempt_status text;

alter table public.store_orders
  drop constraint if exists store_orders_provider_check;
alter table public.store_orders
  add constraint store_orders_provider_check
  check (provider is null or provider in ('asaas', 'fake'));

alter table public.store_orders
  drop constraint if exists store_orders_gateway_environment_check;
alter table public.store_orders
  add constraint store_orders_gateway_environment_check
  check (gateway_environment is null or gateway_environment in ('sandbox', 'production'));

comment on column public.store_orders.provider is
  'Gateway da cobranca da Loja: asaas | fake. Fake so e permitido fora de producao.';
comment on column public.store_orders.gateway_account_key is
  'Rotulo da conta Asaas persistido na criacao da cobranca. Historico resolve por este valor.';
comment on column public.store_orders.gateway_environment is
  'sandbox | production da cobranca. UI mostra LIVE para production.';

drop function if exists public.start_store_order_payment_pix(uuid, text, text, text, timestamptz);

create or replace function public.start_store_order_payment_pix(
  p_store_order_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz,
  p_provider text default 'fake',
  p_gateway_account_key text default null,
  p_gateway_environment text default null,
  p_checkout_url text default null,
  p_payment_method text default 'pix'
)
returns public.store_orders
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.store_orders%rowtype;
  v_provider text := lower(trim(coalesce(p_provider, 'fake')));
  v_method text := lower(trim(coalesce(p_payment_method, 'pix')));
begin
  if v_actor is null then raise exception 'Usuario autenticado obrigatorio.'; end if;
  if v_provider not in ('fake', 'asaas') then raise exception 'Provider de pagamento invalido.'; end if;
  if v_method not in ('pix', 'credit_card') then raise exception 'Metodo de pagamento invalido.'; end if;
  if p_gateway_environment is not null
    and p_gateway_environment not in ('sandbox', 'production') then
    raise exception 'Ambiente de gateway invalido.';
  end if;
  if p_gateway_account_key is not null
    and length(trim(p_gateway_account_key)) > 0
    and (
      length(trim(p_gateway_account_key)) > 64
      or trim(p_gateway_account_key) ~ '[$]|access_token|api[_-]?key'
    ) then
    raise exception 'Identificador de conta do gateway invalido.';
  end if;

  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if v_order.user_id is distinct from v_actor then
    raise exception 'Sem permissao para alterar pagamento deste pedido.';
  end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta pendente de pagamento.'; end if;
  if v_order.payment_status = 'paid' then return v_order; end if;

  update public.store_orders set
    payment_method = v_method,
    pix_code = case when v_method = 'pix' then p_pix_code else pix_code end,
    pix_qrcode = case when v_method = 'pix' then p_pix_qrcode else pix_qrcode end,
    gateway_payment_id = p_gateway_payment_id,
    gateway_checkout_url = coalesce(p_checkout_url, gateway_checkout_url),
    expires_at = p_expires_at,
    provider = v_provider,
    gateway_account_key = nullif(trim(coalesce(p_gateway_account_key, '')), ''),
    gateway_environment = p_gateway_environment,
    last_gateway_attempt_status = null,
    updated_at = now()
  where id = p_store_order_id
  returning * into v_order;

  return v_order;
end;
$$;

revoke all on function public.start_store_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text, text) from public;
grant execute on function public.start_store_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text, text) to authenticated, service_role;

create or replace function public.apply_store_order_gateway_status(
  p_provider text,
  p_provider_payment_id text,
  p_provider_status text,
  p_internal_status text,
  p_expected_gateway_account_key text default null,
  p_event_type text default null
)
returns table(store_order_id uuid, organization_id uuid, previous_status text, applied_status text)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order public.store_orders%rowtype;
  v_expected text := nullif(trim(coalesce(p_expected_gateway_account_key, '')), '');
  v_event text := upper(trim(coalesce(p_event_type, '')));
  v_previous text;
  v_line record;
begin
  if p_internal_status not in ('pending','processing','paid','expired','cancelled','refunded','chargeback','failed') then
    raise exception 'Status interno invalido: %', p_internal_status;
  end if;
  if nullif(trim(coalesce(p_provider_payment_id,'')),'') is null then
    raise exception 'provider_payment_id obrigatorio.';
  end if;

  if v_expected is not null then
    select * into v_order
    from public.store_orders
    where provider = p_provider
      and gateway_payment_id = p_provider_payment_id
      and coalesce(gateway_account_key, '') = v_expected
    for update;

    if not found then
      if exists (
        select 1 from public.store_orders
        where provider = p_provider and gateway_payment_id = p_provider_payment_id
      ) then
        raise exception using errcode='P0001', message='GATEWAY_ACCOUNT_MISMATCH';
      end if;
      raise exception using errcode='P0001', message='STORE_ORDER_NOT_FOUND';
    end if;
  else
    select * into v_order
    from public.store_orders
    where provider = p_provider and gateway_payment_id = p_provider_payment_id
    for update;
    if not found then
      raise exception using errcode='P0001', message='STORE_ORDER_NOT_FOUND';
    end if;
  end if;

  v_previous := v_order.payment_status;

  if v_event in ('PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED') then
    p_internal_status := 'refunded';
  end if;

  if v_event = 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED' then
    if v_order.status = 'pending' then
      update public.store_orders
      set last_gateway_attempt_status = 'refused', updated_at = now()
      where id = v_order.id;
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
    if v_order.status in ('cancelled', 'expired') then
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

    update public.store_orders set
      status = 'confirmed',
      payment_status = 'paid',
      paid_at = now(),
      confirmed_at = now(),
      last_gateway_attempt_status = null,
      updated_at = now()
    where id = v_order.id;
    update public.store_order_items set status = 'confirmed'
    where store_order_id = v_order.id and status = 'reserved';
    update public.store_order_item_pickup_units set status = 'confirmed', updated_at = now()
    where store_order_item_id in (select id from public.store_order_items where store_order_id = v_order.id)
      and status = 'reserved';
    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_payment_confirmed',
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object('provider', p_provider, 'provider_payment_id', p_provider_payment_id)
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
      select * from public.store_order_items
      where store_order_id = v_order.id and status <> 'cancelled'
      for update
    loop
      perform public.release_store_item_reservation(v_line.store_item_id, v_line.variant_id, v_line.quantity);
      update public.store_order_items set status = 'cancelled' where id = v_line.id;
      update public.store_order_item_pickup_units set status = 'cancelled', updated_at = now()
      where store_order_item_id = v_line.id and status <> 'delivered';
    end loop;

    update public.store_orders set
      status = case when p_internal_status = 'expired' then 'expired' else 'cancelled' end,
      payment_status = 'cancelled',
      cancelled_at = now(),
      updated_at = now()
    where id = v_order.id;

    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_payment_'||p_internal_status,
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object('provider', p_provider, 'provider_payment_id', p_provider_payment_id)
    );
  end if;

  return query
    select v_order.id, v_order.organization_id, v_previous,
      (select payment_status from public.store_orders where id = v_order.id);
end;
$$;

revoke all on function public.apply_store_order_gateway_status(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_store_order_gateway_status(text, text, text, text, text, text) to service_role;

create or replace function public.expire_expired_store_orders()
returns integer
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_order public.store_orders%rowtype;
  v_line record;
  v_count integer := 0;
begin
  for v_order in
    select * from public.store_orders
    where status = 'pending'
      and payment_status = 'pending'
      and expires_at is not null
      and expires_at <= now()
    for update skip locked
  loop
    for v_line in
      select * from public.store_order_items
      where store_order_id = v_order.id and status <> 'cancelled'
      for update
    loop
      perform public.release_store_item_reservation(v_line.store_item_id, v_line.variant_id, v_line.quantity);
      update public.store_order_items set status = 'cancelled' where id = v_line.id;
      update public.store_order_item_pickup_units set status = 'cancelled', updated_at = now()
      where store_order_item_id = v_line.id and status <> 'delivered';
    end loop;

    update public.store_orders set
      status = 'expired',
      payment_status = 'cancelled',
      cancelled_at = now(),
      updated_at = now()
    where id = v_order.id;

    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values (
      'store_order_expired',
      'store_orders',
      v_order.id,
      v_order.event_id,
      jsonb_build_object('gateway_payment_id', v_order.gateway_payment_id, 'provider', v_order.provider)
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.expire_expired_store_orders() from public;
grant execute on function public.expire_expired_store_orders() to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'expire_expired_store_orders_every_5m') then
      perform cron.schedule('expire_expired_store_orders_every_5m', '*/5 * * * *', 'select public.expire_expired_store_orders()');
    end if;
  end if;
exception when others then
  null;
end $$;

commit;
