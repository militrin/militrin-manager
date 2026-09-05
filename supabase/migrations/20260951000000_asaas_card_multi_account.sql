begin;

-- Gate Asaas cartao + multi-conta por metodo.
-- Nao altera valores historicos de payments.gateway_account_key.

-- ============================================================
-- 1) URL hospedada do checkout de cartao (invoiceUrl Asaas).
-- ============================================================
alter table public.payments
  add column if not exists gateway_checkout_url text;

comment on column public.payments.gateway_checkout_url is
  'URL hospedada do gateway para captura segura de cartao (Asaas invoiceUrl). Nunca contem PAN/CVV.';

-- ============================================================
-- 2) Dedup de webhook por conta.
-- Asaas nao documenta external_event_id como global entre contas; ids
-- sequenciais (evt_...) podem coincidir. Unicidade passa a incluir
-- gateway_account_key. Pagamentos PIX/CARTAO da MESMA conta continuam
-- com o mesmo rotulo, equivalente ao unique antigo.
-- ============================================================
alter table public.payment_gateway_events
  add column if not exists gateway_account_key text;

comment on column public.payment_gateway_events.gateway_account_key is
  'Rotulo da conta Asaas que autenticou o webhook (token → account_key). Historico de eventos sem valor permanece coalesce vazio.';

alter table public.payment_gateway_events
  drop constraint if exists payment_gateway_events_provider_external_event_id_key;

drop index if exists public.ux_payment_gateway_events_provider_account_event;

create unique index ux_payment_gateway_events_provider_account_event
  on public.payment_gateway_events (provider, external_event_id, coalesce(gateway_account_key, ''));

-- ============================================================
-- 3) record_payment_gateway_event inclui account_key na idempotencia.
-- ============================================================
drop function if exists public.record_payment_gateway_event(text, text, text, text, jsonb, uuid);

create or replace function public.record_payment_gateway_event(
  p_provider text,
  p_external_event_id text,
  p_event_type text,
  p_provider_payment_id text,
  p_payload jsonb,
  p_organization_id uuid default null,
  p_gateway_account_key text default null
)
returns table(id uuid, is_new boolean)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id uuid;
  v_account_key text := nullif(trim(coalesce(p_gateway_account_key, '')), '');
begin
  if p_provider is null or p_provider not in ('fake','asaas') then
    raise exception 'Provider invalido.';
  end if;
  if nullif(trim(coalesce(p_external_event_id,'')),'') is null then
    raise exception 'external_event_id obrigatorio.';
  end if;

  select pge.id into v_id
  from public.payment_gateway_events pge
  where pge.provider = p_provider
    and pge.external_event_id = p_external_event_id
    and coalesce(pge.gateway_account_key, '') = coalesce(v_account_key, '');

  if v_id is not null then
    return query select v_id, false;
    return;
  end if;

  insert into public.payment_gateway_events(
    organization_id, provider, external_event_id, event_type, provider_payment_id, payload, gateway_account_key
  ) values (
    p_organization_id, p_provider, p_external_event_id, p_event_type, p_provider_payment_id, p_payload, v_account_key
  )
  returning payment_gateway_events.id into v_id;

  return query select v_id, true;
exception when unique_violation then
  select pge.id into v_id
  from public.payment_gateway_events pge
  where pge.provider = p_provider
    and pge.external_event_id = p_external_event_id
    and coalesce(pge.gateway_account_key, '') = coalesce(v_account_key, '');
  return query select v_id, false;
end;
$$;

revoke all on function public.record_payment_gateway_event(text, text, text, text, jsonb, uuid, text)
from public, anon, authenticated;
grant execute on function public.record_payment_gateway_event(text, text, text, text, jsonb, uuid, text)
to service_role;

-- ============================================================
-- 4) apply_gateway_payment_status recusa conta errada.
-- Parametro novo com default: testes Gate #1 que nao passam account_key
-- continuam validos. O webhook sempre envia p_expected_gateway_account_key.
-- ============================================================
drop function if exists public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric);

create or replace function public.apply_gateway_payment_status(
  p_provider text,
  p_provider_payment_id text,
  p_provider_status text,
  p_internal_status text,
  p_paid_at timestamptz default null,
  p_fee_amount numeric default null,
  p_net_amount numeric default null,
  p_expected_gateway_account_key text default null
)
returns table(payment_id uuid, order_id uuid, organization_id uuid, previous_status text, applied_status text)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment public.payments%rowtype;
  v_previous text;
  v_applied text;
  v_expected_key text := nullif(trim(coalesce(p_expected_gateway_account_key, '')), '');
begin
  if p_internal_status not in ('pending','processing','paid','expired','cancelled','refunded','chargeback','failed') then
    raise exception 'Status interno invalido: %', p_internal_status;
  end if;
  if nullif(trim(coalesce(p_provider_payment_id,'')),'') is null then
    raise exception 'provider_payment_id obrigatorio.';
  end if;

  select * into v_payment from public.payments
  where provider = p_provider and gateway_payment_id = p_provider_payment_id
  for update;

  if not found then
    raise exception using errcode='P0001', message='PAYMENT_NOT_FOUND',
      detail=jsonb_build_object('code','PAYMENT_NOT_FOUND','provider',p_provider,'provider_payment_id',p_provider_payment_id)::text;
  end if;

  if v_expected_key is not null then
    if v_payment.gateway_account_key is null
      or v_payment.gateway_account_key is distinct from v_expected_key then
      raise exception using errcode='P0001', message='GATEWAY_ACCOUNT_MISMATCH',
        detail=jsonb_build_object(
          'code','GATEWAY_ACCOUNT_MISMATCH',
          'provider',p_provider,
          'provider_payment_id',p_provider_payment_id
        )::text;
    end if;
  end if;

  v_previous := v_payment.payment_status;

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
      update public.payments set provider_status = p_provider_status, updated_at = now() where id = v_payment.id;
      return query select v_payment.id, v_payment.order_id, v_payment.organization_id, v_previous, 'paid';
      return;
    end if;

    update public.payments set
      payment_status = 'paid',
      provider_status = p_provider_status,
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

revoke all on function public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric, text)
from public, anon, authenticated;
grant execute on function public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric, text)
to service_role;

-- ============================================================
-- 5) Persistencia PIX/cartao: metodo, checkout_url, sem forcar pix.
-- gateway_account_key so e gravado na criacao da cobranca; se o payment
-- ja esta paid, o valor historico permanece.
-- ============================================================
drop function if exists public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text);

create or replace function public.start_order_payment_pix(
  p_order_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz,
  p_provider text default 'fake',
  p_gateway_account_key text default null,
  p_payment_method text default 'pix',
  p_checkout_url text default null
)
returns table(payment_id uuid, order_id uuid, event_id uuid, amount numeric, discount_amount numeric, final_amount numeric, payment_method text, payment_status text, pix_code text, pix_qrcode text, gateway_payment_id text, expires_at timestamptz, paid_at timestamptz, checkout_url text)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_method text := coalesce(nullif(trim(p_payment_method), ''), 'pix');
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
  end if;
  if p_provider is not null and p_provider not in ('fake','asaas') then
    raise exception 'Provider de pagamento invalido.';
  end if;
  if v_method not in ('pix', 'credit_card') then
    raise exception 'Metodo de pagamento invalido.';
  end if;
  if p_gateway_account_key is not null
    and length(trim(p_gateway_account_key)) > 0
    and (
      length(trim(p_gateway_account_key)) > 64
      or trim(p_gateway_account_key) ~ '[$]|access_token|api[_-]?key'
    ) then
    raise exception 'Identificador de conta do gateway invalido.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;
  if v_order.user_id is distinct from v_actor then
    raise exception 'Sem permissao para alterar pagamento deste pedido.';
  end if;

  select * into v_payment
  from public.payments
  where public.payments.order_id = p_order_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;

  if v_payment.payment_status = 'paid' then
    return query
    select
      v_payment.id, p_order_id, v_payment.event_id, v_payment.amount,
      coalesce(v_payment.discount_amount, 0), coalesce(v_payment.final_amount, v_payment.amount),
      v_payment.payment_method, v_payment.payment_status,
      v_payment.pix_code, v_payment.pix_qrcode, v_payment.gateway_payment_id,
      v_payment.expires_at, v_payment.paid_at, v_payment.gateway_checkout_url;
    return;
  end if;

  update public.payments
  set payment_method = v_method,
      payment_status = 'pending',
      pix_code = case when v_method = 'pix' then p_pix_code else null end,
      pix_qrcode = case when v_method = 'pix' then p_pix_qrcode else null end,
      gateway_checkout_url = case when v_method = 'credit_card' then nullif(trim(p_checkout_url), '') else null end,
      gateway_payment_id = p_gateway_payment_id,
      provider = coalesce(p_provider, 'fake'),
      provider_status = null,
      gateway_account_key = coalesce(nullif(trim(p_gateway_account_key), ''), gateway_account_key),
      pix_generation_started_at = null,
      expires_at = p_expires_at,
      paid_at = null,
      updated_at = now()
  where id = v_payment.id
  returning * into v_payment;

  update public.order_items oi
  set status = 'reserved',
      reservation_expires_at = p_expires_at,
      updated_at = now()
  where oi.order_id = p_order_id
    and status not in ('cancelled', 'refunded', 'transferred');

  update public.orders
  set status = 'pending',
      cancelled_at = null
  where id = p_order_id;

  return query
  select
    v_payment.id, p_order_id, v_payment.event_id, v_payment.amount,
    coalesce(v_payment.discount_amount, 0), coalesce(v_payment.final_amount, v_payment.amount),
    v_payment.payment_method, v_payment.payment_status,
    v_payment.pix_code, v_payment.pix_qrcode, v_payment.gateway_payment_id,
    v_payment.expires_at, v_payment.paid_at, v_payment.gateway_checkout_url;
end;
$$;

revoke all on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text)
to authenticated;

-- ============================================================
-- 6) Claim: reusa cobranca viva por gateway_payment_id (PIX e cartao).
-- ============================================================
create or replace function public.claim_order_pix_generation(p_order_id uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  if v_actor is null then
    raise exception 'Usuario autenticado obrigatorio.';
  end if;
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;
  if v_order.user_id is distinct from v_actor then
    raise exception 'Sem permissao para alterar pagamento deste pedido.';
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

  if v_payment.payment_status = 'paid' then
    return jsonb_build_object('action', 'paid', 'payment_id', v_payment.id);
  end if;

  if v_payment.payment_status = 'pending'
    and coalesce(v_payment.gateway_payment_id, '') <> ''
    and v_payment.expires_at is not null
    and v_payment.expires_at > now() then
    return jsonb_build_object(
      'action', 'reuse',
      'payment_id', v_payment.id,
      'gateway_payment_id', v_payment.gateway_payment_id
    );
  end if;

  if v_payment.pix_generation_started_at is not null
    and v_payment.pix_generation_started_at > now() - interval '45 seconds' then
    raise exception 'PIX_GENERATION_IN_PROGRESS';
  end if;

  update public.payments
  set pix_generation_started_at = now(),
      updated_at = now()
  where id = v_payment.id;

  return jsonb_build_object(
    'action', 'claim',
    'payment_id', v_payment.id,
    'organization_id', v_payment.organization_id,
    'previous_provider', v_payment.provider,
    'previous_gateway_payment_id', v_payment.gateway_payment_id,
    'previous_gateway_account_key', v_payment.gateway_account_key
  );
end;
$$;

revoke all on function public.claim_order_pix_generation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_order_pix_generation(uuid) to authenticated;

-- ============================================================
-- 7) Snapshot do carrinho expoe checkout_url e parcelas.
-- ============================================================
create or replace function public.get_cart_order_details(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_event public.events%rowtype;
  v_payment public.payments%rowtype; v_items jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  select * into v_event from public.events where id = v_order.event_id;
  select * into v_payment from public.payments where order_id = p_order_id order by created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', oi.id, 'item_kind', oi.item_kind, 'status', oi.status, 'quantity', oi.quantity,
    'item_position', oi.item_position, 'ownership_status', oi.ownership_status,
    'unit_price', oi.unit_price, 'product_base_unit_price', oi.product_base_unit_price, 'discount_amount', oi.discount_amount, 'final_amount', oi.final_amount,
    'ticket_category_id', oi.ticket_category_id, 'category_name', tc.name, 'batch_name', rb.name,
    'shirt_type', oi.shirt_type, 'shirt_size', oi.shirt_size, 'pricing_gender', oi.pricing_gender,
    'holder_full_name', oi.holder_full_name,
    'participant_id', oi.participant_id, 'participant_name', part.full_name,
    'ticket_id', t.id, 'ticket_status', t.status, 'ticket_token', t.token,
    'store_item_id', oi.store_item_id, 'store_item_name', si.name,
    'store_item_image_url', (select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1),
    'store_item_variant_id', oi.store_item_variant_id, 'variant_name', siv.name, 'variant_value', siv.value,
    'pickup_qr_mode', oi.pickup_qr_mode, 'delivered_at', oi.delivered_at,
    'pickup_units', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'unit_id', u.id, 'unit_index', u.unit_index, 'status', u.status, 'delivered_at', u.delivered_at
      ) order by u.unit_index), '[]'::jsonb)
      from public.order_item_pickup_units u where u.order_item_id = oi.id
    )
  ) order by case oi.item_kind when 'ticket' then 0 else 1 end, oi.item_position nulls last, oi.created_at), '[]'::jsonb)
  into v_items
  from public.order_items oi
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.registration_batches rb on rb.id = oi.batch_id
  left join public.participants part on part.id = oi.participant_id
  left join public.tickets t on t.order_item_id = oi.id
  left join public.store_items si on si.id = oi.store_item_id
  left join public.store_item_variants siv on siv.id = oi.store_item_variant_id
  where oi.order_id = p_order_id and oi.status not in ('cancelled','expired','refunded','transferred');

  return jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number, 'order_status', v_order.status,
    'event_id', v_order.event_id, 'event_name', v_event.name,
    'status', v_order.status,
    'base_amount', v_order.base_amount, 'discount_amount', v_order.discount_amount, 'final_amount', v_order.final_amount,
    'applied_coupon_id', v_order.applied_coupon_id,
    'applied_coupon_code', (select code from public.coupons where id = v_order.applied_coupon_id),
    'payment', case when v_payment.id is null then null else jsonb_build_object(
      'payment_id', v_payment.id, 'amount', v_payment.amount, 'discount_amount', v_payment.discount_amount,
      'final_amount', v_payment.final_amount, 'payment_method', v_payment.payment_method, 'payment_status', v_payment.payment_status,
      'pix_code', v_payment.pix_code, 'pix_qrcode', v_payment.pix_qrcode, 'gateway_payment_id', v_payment.gateway_payment_id,
      'expires_at', v_payment.expires_at, 'paid_at', v_payment.paid_at,
      'checkout_url', v_payment.gateway_checkout_url,
      'installments', v_payment.installments,
      'payment_fee_mode', v_payment.payment_fee_mode,
      'payment_fee_calculated_amount', v_payment.payment_fee_calculated_amount,
      'payment_fee_customer_amount', v_payment.payment_fee_customer_amount,
      'payment_fee_organizer_amount', v_payment.payment_fee_organizer_amount
    ) end,
    'items', v_items
  );
end; $$;

commit;
