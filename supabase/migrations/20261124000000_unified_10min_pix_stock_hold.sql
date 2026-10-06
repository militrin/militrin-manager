-- P2: hold PIX/estoque unificado de 10 min. NAO aplicar em producao sem GO.
--
-- Estoque so e liberado DEPOIS de invalidar a cobranca Asaas (DELETE) com
-- sucesso, ou de confirmar que ja estava removida. Falha de DELETE (timeout/
-- 5xx) mantem o item reserved e o payment pending.
--
-- Holds legado (expires_at comercial 23:59 / QR longo), inclusive 2301/2302,
-- NAO entram no expire_stale automatico. Snapshot e corte em etapa separada.
-- Cartao (2295) fica fora deste worker: ciclo proprio, nao DELETE/PIX.
--
-- Asaas: dueDate continua DATE; QR nao expira em 10 min. Invalidacao = DELETE.

begin;

alter table public.payments
  add column if not exists expiration_attempt_count integer not null default 0,
  add column if not exists expiration_last_error text,
  add column if not exists expiration_last_attempt_at timestamptz,
  add column if not exists expiration_lease_until timestamptz;

create or replace function public.is_short_checkout_hold(
  p_created_at timestamptz,
  p_expires_at timestamptz
) returns boolean
language sql
stable
parallel safe
as $$
  select p_expires_at is not null
     and p_created_at is not null
     and p_expires_at <= p_created_at + interval '30 minutes';
$$;

comment on function public.is_short_checkout_hold(timestamptz, timestamptz) is
  'True para holds novos de 10 min. False para expires_at comercial legado (23:59 / QR 12m).';

create or replace function public.checkout_hold_expires_at(
  p_created_at timestamptz,
  p_expires_at timestamptz
) returns timestamptz
language sql
stable
parallel safe
as $$
  select case
    when public.is_short_checkout_hold(p_created_at, p_expires_at) then p_expires_at
    else p_expires_at
  end;
$$;

comment on function public.checkout_hold_expires_at(timestamptz, timestamptz) is
  'Instante em que o hold de 10 min vence. Holds legado nao sao encurtados aqui.';

revoke all on function public.is_short_checkout_hold(timestamptz, timestamptz) from public;
grant execute on function public.is_short_checkout_hold(timestamptz, timestamptz) to authenticated, service_role;
revoke all on function public.checkout_hold_expires_at(timestamptz, timestamptz) from public;
grant execute on function public.checkout_hold_expires_at(timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.canonical_shirt_valid_unaccounted_hold_qty(
  p_event_id uuid,
  p_shirt_type text,
  p_shirt_size text,
  p_exclude_order_item_id uuid default null
) returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(greatest(coalesce(oi.quantity, 1), 1)), 0)::integer
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join lateral (
    select p.payment_status
    from public.payments p
    where p.order_id = o.id
    order by p.created_at desc
    limit 1
  ) pay on true
  where oi.event_id = p_event_id
    and coalesce(oi.item_kind, 'ticket') = 'ticket'
    and oi.status not in ('cancelled', 'expired', 'refunded', 'transferred')
    and lower(trim(coalesce(oi.shirt_type, ''))) = lower(trim(coalesce(p_shirt_type, '')))
    and upper(trim(coalesce(oi.shirt_size, ''))) = upper(trim(coalesce(p_shirt_size, '')))
    and (p_exclude_order_item_id is null or oi.id <> p_exclude_order_item_id)
    and pay.payment_status = 'pending'
    and not exists (select 1 from public.tickets t where t.order_item_id = oi.id)
    and not exists (
      select 1
      from public.tickets t
      join public.participant_kit_items pki on pki.ticket_id = t.id
      join public.event_kit_items eki on eki.id = pki.kit_item_id and eki.item_type = 'shirt'
      where t.order_item_id = oi.id
        and pki.inventory_reservation_accounted
        and pki.status not in ('cancelled')
    );
$$;

comment on function public.canonical_shirt_valid_unaccounted_hold_qty(uuid, text, text, uuid) is
  'Demanda de checkout ainda pending (inclui espera de DELETE Asaas). STABLE, sem lock. Nao libera por relogio.';

revoke all on function public.canonical_shirt_valid_unaccounted_hold_qty(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.canonical_shirt_valid_unaccounted_hold_qty(uuid, text, text, uuid) to authenticated, service_role;

create or replace function public.canonical_shirt_available_for_new_reservation(
  p_event_id uuid,
  p_shirt_type text,
  p_shirt_size text,
  p_exclude_order_item_id uuid default null
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total integer := 0;
  v_reserved integer := 0;
  v_delivered integer := 0;
  v_pending integer := 0;
  v_type text := nullif(trim(coalesce(p_shirt_type, '')), '');
  v_size text := nullif(trim(coalesce(p_shirt_size, '')), '');
begin
  if p_event_id is null or v_type is null or v_size is null then
    return 0;
  end if;

  v_size := upper(v_size);

  select coalesce(si.total_quantity, 0)
    into v_total
  from public.shirt_inventory si
  where si.event_id = p_event_id
    and lower(trim(si.shirt_type)) = lower(v_type)
    and upper(trim(si.shirt_size)) = v_size
  order by si.id
  limit 1
  for update;

  if not found then
    return 0;
  end if;

  select coalesce(inv.reserved_quantity, 0), coalesce(inv.delivered_quantity, 0)
    into v_reserved, v_delivered
  from public.event_kit_item_variant_inventory inv
  join public.event_kit_item_variants v on v.id = inv.variant_id
  join public.event_kit_items eki
    on eki.id = inv.kit_item_id
   and eki.item_type = 'shirt'
   and eki.is_active
  where inv.event_id = p_event_id
    and lower(trim(v.name)) = lower(v_type)
    and upper(trim(v.value)) = v_size
  order by inv.id
  limit 1
  for update of inv;

  if not found then
    v_reserved := 0;
    v_delivered := 0;
  end if;

  v_pending := public.canonical_shirt_valid_unaccounted_hold_qty(
    p_event_id, v_type, v_size, p_exclude_order_item_id
  );

  return greatest(v_total - v_delivered - v_reserved - coalesce(v_pending, 0), 0);
end;
$$;

drop function if exists public.get_event_shirt_stock_for_selection(uuid);

create or replace function public.get_event_shirt_stock_for_selection(p_event_id uuid)
returns table (
  shirt_type text,
  shirt_size text,
  total_quantity integer,
  reserved_quantity integer,
  delivered_quantity integer,
  checkout_hold_quantity integer,
  available_quantity integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    si.shirt_type,
    si.shirt_size,
    coalesce(si.total_quantity, 0)::integer,
    coalesce(kit.reserved_quantity, 0)::integer,
    coalesce(kit.delivered_quantity, 0)::integer,
    public.canonical_shirt_valid_unaccounted_hold_qty(
      si.event_id, si.shirt_type, si.shirt_size, null
    )::integer,
    greatest(
      coalesce(si.total_quantity, 0)
      - coalesce(kit.delivered_quantity, 0)
      - coalesce(kit.reserved_quantity, 0)
      - public.canonical_shirt_valid_unaccounted_hold_qty(
          si.event_id, si.shirt_type, si.shirt_size, null
        ),
      0
    )::integer
  from public.shirt_inventory si
  left join lateral (
    select inv.reserved_quantity, inv.delivered_quantity
    from public.event_kit_item_variant_inventory inv
    join public.event_kit_item_variants v on v.id = inv.variant_id
    join public.event_kit_items eki
      on eki.id = inv.kit_item_id
     and eki.item_type = 'shirt'
     and eki.is_active
    where inv.event_id = si.event_id
      and lower(trim(v.name)) = lower(trim(si.shirt_type))
      and upper(trim(v.value)) = upper(trim(si.shirt_size))
    order by inv.id
    limit 1
  ) kit on true
  where si.event_id = p_event_id;
$$;

grant execute on function public.get_event_shirt_stock_for_selection(uuid) to anon, authenticated, service_role;

create or replace function public.expire_stale_order_payments(p_organization_id uuid default null)
returns integer
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_payment public.payments%rowtype;
  v_count integer := 0;
  v_needs_gateway boolean := false;
begin
  if v_actor is not null then
    if p_organization_id is null then
      raise exception 'organization_id obrigatorio para execucao manual.';
    end if;
    if not (public.current_user_has_permission('orders.cancel') and public.user_can_access_organization(v_actor, p_organization_id)) then
      raise exception 'Sem permissao para expirar pedidos desta organizacao.';
    end if;
  end if;

  for v_payment in
    select p.* from public.payments p
    where p.payment_status = 'pending'
      and p.order_id is not null
      and lower(coalesce(p.payment_method, 'pix')) = 'pix'
      and public.is_short_checkout_hold(p.created_at, p.expires_at)
      and public.checkout_hold_expires_at(p.created_at, p.expires_at) <= now()
      and (p_organization_id is null or p.organization_id = p_organization_id)
    order by p.created_at
    for update skip locked
  loop
    v_needs_gateway := coalesce(v_payment.provider, '') = 'asaas'
      and nullif(trim(coalesce(v_payment.gateway_payment_id, '')), '') is not null;

    if v_needs_gateway then
      if v_payment.pending_cancel_provider_payment_id is null then
        update public.payments
        set pending_cancel_provider = v_payment.provider,
            pending_cancel_provider_payment_id = v_payment.gateway_payment_id,
            updated_at = now()
        where id = v_payment.id;
        insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
        values (
          'payment_expiration_pending_cancel',
          'payments',
          v_payment.id,
          v_payment.event_id,
          jsonb_build_object(
            'order_id', v_payment.order_id,
            'gateway_payment_id', v_payment.gateway_payment_id,
            'provider', v_payment.provider
          )
        );
        v_count := v_count + 1;
      end if;
      continue;
    end if;

    perform public._apply_terminal_order_payment_status(v_payment.id, 'expired');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.expire_stale_order_payments(uuid) from public;
grant execute on function public.expire_stale_order_payments(uuid) to authenticated, service_role;

create or replace function public.claim_expired_pix_cancellations(
  p_limit integer default 20,
  p_organization_id uuid default null
)
returns table(
  payment_id uuid,
  organization_id uuid,
  provider text,
  provider_payment_id text,
  gateway_account_key text,
  order_id uuid
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  return query
  with picked as (
    select p.id
    from public.payments p
    where p.payment_status = 'pending'
      and p.pending_cancel_provider_payment_id is not null
      and lower(coalesce(p.payment_method, 'pix')) = 'pix'
      and coalesce(p.provider, '') = 'asaas'
      and (p.expiration_lease_until is null or p.expiration_lease_until < now())
      and (p_organization_id is null or p.organization_id = p_organization_id)
    order by coalesce(p.expiration_last_attempt_at, p.created_at)
    for update skip locked
    limit greatest(coalesce(p_limit, 20), 1)
  )
  update public.payments pay
  set expiration_lease_until = now() + interval '60 seconds',
      expiration_last_attempt_at = now(),
      expiration_attempt_count = coalesce(pay.expiration_attempt_count, 0) + 1,
      updated_at = now()
  from picked
  where pay.id = picked.id
  returning
    pay.id,
    pay.organization_id,
    pay.pending_cancel_provider,
    pay.pending_cancel_provider_payment_id,
    pay.gateway_account_key,
    pay.order_id;
end;
$$;

revoke all on function public.claim_expired_pix_cancellations(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_expired_pix_cancellations(integer, uuid) to service_role;

create or replace function public.complete_expired_pix_cancellation(p_payment_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment public.payments%rowtype;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_payment.payment_status = 'paid' then
    update public.payments
    set pending_cancel_provider = null,
        pending_cancel_provider_payment_id = null,
        expiration_lease_until = null,
        expiration_last_error = null,
        updated_at = now()
    where id = p_payment_id;
    return 'already_paid';
  end if;
  if v_payment.payment_status in ('expired', 'cancelled', 'refunded') then
    update public.payments
    set pending_cancel_provider = null,
        pending_cancel_provider_payment_id = null,
        expiration_lease_until = null,
        expiration_last_error = null,
        updated_at = now()
    where id = p_payment_id;
    return 'already_terminal';
  end if;
  if v_payment.payment_status is distinct from 'pending' then
    return 'incompatible';
  end if;

  perform public._apply_terminal_order_payment_status(p_payment_id, 'expired');

  update public.payments
  set pending_cancel_provider = null,
      pending_cancel_provider_payment_id = null,
      expiration_lease_until = null,
      expiration_last_error = null,
      updated_at = now()
  where id = p_payment_id;

  return 'expired';
end;
$$;

revoke all on function public.complete_expired_pix_cancellation(uuid) from public, anon, authenticated;
grant execute on function public.complete_expired_pix_cancellation(uuid) to service_role;

create or replace function public.fail_expired_pix_cancellation(p_payment_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  update public.payments
  set expiration_lease_until = null,
      expiration_last_error = left(coalesce(p_error, 'unknown'), 1000),
      expiration_last_attempt_at = now(),
      updated_at = now()
  where id = p_payment_id
    and payment_status = 'pending';

  insert into public.audit_logs(action, entity_type, entity_id, details)
  values (
    'payment_expiration_cancel_failed',
    'payments',
    p_payment_id,
    jsonb_build_object('error', left(coalesce(p_error, 'unknown'), 1000))
  );
end;
$$;

revoke all on function public.fail_expired_pix_cancellation(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_expired_pix_cancellation(uuid, text) to service_role;

select cron.unschedule('expire_stale_order_payments_every_2m')
where exists (select 1 from cron.job where jobname = 'expire_stale_order_payments_every_2m');

select cron.schedule(
  'expire_stale_order_payments_every_1m',
  '* * * * *',
  $$select public.expire_stale_order_payments();$$
);


create or replace function public.start_order_payment_pix(
  p_order_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz,
  p_provider text default 'fake',
  p_gateway_account_key text default null,
  p_payment_method text default 'pix',
  p_checkout_url text default null,
  p_gateway_installment_id text default null,
  p_gateway_charges jsonb default null
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
  v_account_key text := nullif(trim(coalesce(p_gateway_account_key, '')), '');
  v_installment_id text := nullif(trim(coalesce(p_gateway_installment_id, '')), '');
  v_item jsonb;
  v_charge_pay_id text;
  v_commercial timestamptz;
  v_hold timestamptz;
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
  if v_account_key is not null
    and (
      length(v_account_key) > 64
      or v_account_key ~ '[$]|access_token|api[_-]?key'
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

  if v_order.status <> 'pending' then
    raise exception 'Pedido nao esta mais no carrinho (status atual: %).', v_order.status;
  end if;
  if v_payment.payment_status in ('expired', 'cancelled', 'refunded') then
    raise exception 'Pagamento nao pode mais ser reiniciado.';
  end if;
  v_hold := now() + interval '10 minutes';
  v_commercial := v_hold;
  if v_payment.expires_at is not null and v_payment.expires_at <= now() then
    raise exception 'Prazo de 10 minutos do pagamento expirado.';
  end if;

  update public.payments
  set payment_method = v_method,
      payment_status = 'pending',
      pix_code = case when v_method = 'pix' then p_pix_code else null end,
      pix_qrcode = case when v_method = 'pix' then p_pix_qrcode else null end,
      gateway_checkout_url = case when v_method = 'credit_card' then nullif(trim(p_checkout_url), '') else null end,
      gateway_payment_id = p_gateway_payment_id,
      gateway_installment_id = v_installment_id,
      last_gateway_attempt_status = null,
      provider = coalesce(p_provider, 'fake'),
      provider_status = null,
      gateway_account_key = coalesce(v_account_key, gateway_account_key),
      pix_generation_started_at = null,
      expires_at = v_hold,
      paid_at = null,
      updated_at = now()
  where id = v_payment.id
  returning * into v_payment;

  update public.payment_gateway_charges
  set reusable = false,
      updated_at = now()
  where payment_gateway_charges.payment_id = v_payment.id
    and payment_gateway_charges.reusable = true;

  if p_gateway_charges is not null and jsonb_typeof(p_gateway_charges) = 'array' then
    for v_item in select value from jsonb_array_elements(p_gateway_charges)
    loop
      v_charge_pay_id := nullif(trim(coalesce(v_item->>'gateway_payment_id', '')), '');
      if v_charge_pay_id is null then
        continue;
      end if;
      insert into public.payment_gateway_charges (
        payment_id, organization_id, provider, gateway_account_key, gateway_payment_id,
        gateway_installment_id, installment_number, installment_count, amount, gateway_status, deleted, reusable
      ) values (
        v_payment.id,
        v_payment.organization_id,
        coalesce(p_provider, 'fake'),
        coalesce(v_account_key, v_payment.gateway_account_key),
        v_charge_pay_id,
        coalesce(nullif(trim(coalesce(v_item->>'gateway_installment_id', '')), ''), v_installment_id),
        nullif(v_item->>'installment_number', '')::integer,
        nullif(v_item->>'installment_count', '')::integer,
        nullif(v_item->>'amount', '')::numeric,
        'PENDING',
        false,
        true
      );
    end loop;
  elsif p_gateway_payment_id is not null and length(trim(p_gateway_payment_id)) > 0 then
    insert into public.payment_gateway_charges (
      payment_id, organization_id, provider, gateway_account_key, gateway_payment_id,
      gateway_installment_id, installment_number, installment_count, amount, gateway_status, deleted, reusable
    ) values (
      v_payment.id,
      v_payment.organization_id,
      coalesce(p_provider, 'fake'),
      coalesce(v_account_key, v_payment.gateway_account_key),
      p_gateway_payment_id,
      v_installment_id,
      1,
      case when v_installment_id is null then 1 else null end,
      coalesce(v_payment.final_amount, v_payment.amount),
      'PENDING',
      false,
      true
    );
  end if;

  update public.order_items oi
  set status = 'reserved',
      reservation_expires_at = v_hold,
      updated_at = now()
  where oi.order_id = p_order_id
    and status not in ('cancelled', 'refunded', 'transferred');

  -- Alinha o relogio do participante-ancora pendente ao hold de 10 minutos.
  -- Nunca toca participante que ja tem ticket active/used.
  update public.participants p
  set reservation_expires_at = v_hold,
      updated_at = now()
  where p.id = v_payment.participant_id
    and p.reservation_status = 'pending'
    and not public.participant_has_issued_event_ticket(p.id);

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

revoke all on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text, text, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text, text, jsonb)
to authenticated;

create or replace function public.create_multi_ticket_order_checkout_legacy(p_event_id uuid, p_ticket_category_id uuid, p_gender text, p_quantity integer, p_payment_method text, p_coupon_code text DEFAULT NULL::text, p_shirt_type text DEFAULT NULL::text, p_shirt_size text DEFAULT NULL::text, p_buyer_full_name text DEFAULT NULL::text, p_buyer_cpf text DEFAULT NULL::text, p_buyer_birth_date date DEFAULT NULL::date, p_buyer_gender text DEFAULT NULL::text, p_buyer_phone text DEFAULT NULL::text, p_buyer_email text DEFAULT NULL::text, p_buyer_city text DEFAULT NULL::text, p_assign_first_to_buyer boolean DEFAULT true, p_items jsonb DEFAULT '[]'::jsonb, p_limit_per_order integer DEFAULT 10, p_notes text DEFAULT NULL::text, p_client_request_id text DEFAULT NULL::text)
 returns table(order_id uuid, payment_id uuid, order_number text, payment_status text, reservation_expires_at timestamp with time zone, item_count integer, amount numeric, discount_amount numeric, final_amount numeric)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_event public.events%rowtype;
  v_pricing record;
  v_batch_id uuid;
  v_batch_name text;
  v_order_id uuid;
  v_order_number text;
  v_payment_id uuid;
  v_anchor_participant_id uuid;
  v_reservation_expires_at timestamptz;
  v_item_index integer;
  v_item_payload jsonb;
  v_item_shirt_type text;
  v_item_shirt_size text;
  v_item_gender text;
  v_item_pricing_gender text;
  v_item_pricing record;
  v_item_bases numeric[] := '{}'::numeric[];
  v_item_discounts numeric[] := '{}'::numeric[];
  v_item_finals numeric[] := '{}'::numeric[];
  v_ownership_status text;
  v_holder_name text;
  v_holder_email text;
  v_holder_phone text;
  v_status text := 'reserved';
  v_payment_status text := 'pending';
  v_total_amount numeric := 0;
  v_total_discount numeric := 0;
  v_total_final numeric := 0;
  v_available_category integer;
  v_required_shirt boolean := false;
  v_inventory public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_existing_order public.orders%rowtype;
begin
  if v_user_id is null then
    raise exception 'Sessao autenticada obrigatoria.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  if coalesce(p_quantity, 0) < 1 then
    raise exception 'Quantidade minima de ingressos: 1.';
  end if;

  if p_limit_per_order is not null and p_quantity > p_limit_per_order then
    raise exception 'Limite maximo por pedido excedido (%).', p_limit_per_order;
  end if;

  if coalesce(trim(coalesce(p_payment_method, '')), '') not in ('pix', 'credit_card', 'cash', 'courtesy') then
    raise exception 'Metodo de pagamento invalido.';
  end if;

  if coalesce(trim(coalesce(p_buyer_full_name, '')), '') = '' then
    raise exception 'Nome do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_cpf, '')), '') = '' then
    raise exception 'CPF do comprador obrigatorio.';
  end if;

  if p_buyer_birth_date is null then
    raise exception 'Data de nascimento do comprador obrigatoria.';
  end if;

  if coalesce(trim(coalesce(p_buyer_gender, '')), '') = '' then
    raise exception 'Genero do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_phone, '')), '') = '' then
    raise exception 'Telefone do comprador obrigatorio.';
  end if;

  if coalesce(trim(coalesce(p_buyer_city, '')), '') = '' then
    raise exception 'Cidade do comprador obrigatoria.';
  end if;

  if coalesce(trim(coalesce(p_buyer_email, '')), '') = '' then
    raise exception 'E-mail do comprador obrigatorio.';
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.registration_enabled, false) then
    raise exception 'Inscricoes fechadas para este evento.';
  end if;

  if v_event.registration_open_at is not null and v_event.registration_open_at > now() then
    raise exception 'Inscricoes ainda nao abertas para este evento.';
  end if;

  if v_event.registration_close_at is not null and v_event.registration_close_at < now() then
    raise exception 'Inscricoes encerradas para este evento.';
  end if;

  if p_client_request_id is not null and trim(p_client_request_id) <> '' then
    select * into v_existing_order
    from public.orders
    where user_id = v_user_id
      and client_request_id = trim(p_client_request_id)
    limit 1;

    if found then
      select pay.id, pay.payment_status, pay.expires_at, pay.amount, pay.discount_amount, pay.final_amount
      into v_payment_id, v_payment_status, v_reservation_expires_at, v_total_amount, v_total_discount, v_total_final
      from public.payments pay
      where pay.order_id = v_existing_order.id
      order by pay.created_at desc
      limit 1;

      return query
      select
        v_existing_order.id,
        v_payment_id,
        v_existing_order.order_number,
        coalesce(v_payment_status, 'pending'),
        v_reservation_expires_at,
        coalesce((select count(*)::integer from public.order_items oi where oi.order_id = v_existing_order.id), 0),
        coalesce(v_total_amount, 0),
        coalesce(v_total_discount, 0),
        coalesce(v_total_final, 0);
      return;
    end if;
  end if;

  select * into v_pricing
  from public.get_registration_pricing_preview(
    p_gender,
    nullif(trim(coalesce(p_coupon_code, '')), ''),
    p_event_id,
    p_ticket_category_id
  )
  limit 1;

  if v_pricing.batch_id is null then
    raise exception 'Nao foi possivel calcular o preco para a categoria.';
  end if;

  v_batch_id := v_pricing.batch_id;
  v_batch_name := v_pricing.batch_name;

  -- get_event_ticket_categories() agora conta direto de order_items (1 item
  -- de ingresso = 1 vaga, com ou sem titular) -- a subtracao manual de
  -- "v_unassigned_in_category" que existia aqui virou redundante E, pior,
  -- incompleta (nunca cobria order_items com titular NOMEADO cujo
  -- participants.ticket_category_id fica null -- ver migration de
  -- correcao de capacidade). Comparar direto contra available_slots.
  select tc.available_slots
  into v_available_category
  from public.get_event_ticket_categories(p_event_id) tc
  where tc.id = p_ticket_category_id
  limit 1;

  if v_available_category is null then
    v_available_category := 2147483647;
  end if;

  if v_available_category < p_quantity then
    raise exception 'Capacidade da categoria insuficiente para % ingressos.', p_quantity;
  end if;

  select exists (
    select 1
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.item_type = 'shirt'
      and eki.is_active = true
      and eki.is_required = true
  ) into v_required_shirt;

  if v_required_shirt and (coalesce(trim(coalesce(p_shirt_type, '')), '') = '' or coalesce(trim(coalesce(p_shirt_size, '')), '') = '') then
    raise exception 'Camiseta obrigatoria para este evento.';
  end if;

  if coalesce(trim(coalesce(p_shirt_type, '')), '') <> '' and coalesce(trim(coalesce(p_shirt_size, '')), '') <> '' then
    select * into v_inventory
    from public.shirt_inventory
    where event_id = p_event_id
      and shirt_type = p_shirt_type
      and shirt_size = p_shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para este modelo e tamanho.';
    end if;

    -- 20261124: a autoridade de disponibilidade e
    -- assert_canonical_shirt_stock_for_new_checkout / helper STABLE.
    -- Nao decidir por shirt_inventory.reserved/delivered.
  end if;

  -- Fix: preco por item, nao mais v_pricing.X (preco do primeiro item, via
  -- p_gender) multiplicado por p_quantity. Cada ingresso resolve o proprio
  -- pricing_gender (mesma prioridade item->scalar da correcao da camiseta) e
  -- chama get_registration_pricing_preview individualmente -- o mesmo RPC
  -- que o frontend ja chama uma vez por item durante o bootstrap de preco.
  -- v_total_amount/discount/final viram a SOMA real das linhas, nao mais uma
  -- multiplicacao que assumia preco uniforme entre ingressos.
  for v_item_index in 1..p_quantity loop
    v_item_payload := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_item_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;

    v_item_gender := nullif(trim(coalesce(v_item_payload ->> 'pricing_gender', p_gender, '')), '');

    select * into v_item_pricing
    from public.get_registration_pricing_preview(
      v_item_gender,
      nullif(trim(coalesce(p_coupon_code, '')), ''),
      p_event_id,
      p_ticket_category_id
    )
    limit 1;

    if v_item_pricing.batch_id is null then
      raise exception 'Nao foi possivel calcular o preco do ingresso %.', v_item_index;
    end if;

    v_item_bases[v_item_index] := coalesce(v_item_pricing.base_amount, 0);
    v_item_discounts[v_item_index] := coalesce(v_item_pricing.discount_amount, 0);
    v_item_finals[v_item_index] := coalesce(v_item_pricing.final_amount, 0);

    v_total_amount := v_total_amount + v_item_bases[v_item_index];
    v_total_discount := v_total_discount + v_item_discounts[v_item_index];
    v_total_final := v_total_final + v_item_finals[v_item_index];
  end loop;

  v_total_amount := round(v_total_amount, 2);
  v_total_discount := round(v_total_discount, 2);
  v_total_final := round(v_total_final, 2);

  if lower(trim(coalesce(p_payment_method, ''))) = 'courtesy' or v_total_final <= 0 then
    v_payment_status := 'paid';
    v_status := 'confirmed';
    v_reservation_expires_at := null;
  else
    v_payment_status := 'pending';
    v_status := 'reserved';
    v_reservation_expires_at := now() + interval '10 minutes';
  end if;

  select p.id into v_anchor_participant_id
  from public.participants p
  where p.event_id = p_event_id
    and regexp_replace(coalesce(p.cpf, ''), '\\D', '', 'g') = regexp_replace(coalesce(p_buyer_cpf, ''), '\\D', '', 'g')
    and p.user_id = v_user_id
  order by p.created_at asc
  limit 1
  for update;

  if v_anchor_participant_id is null then
    insert into public.participants (
      event_id, full_name, cpf, birth_date, gender, phone, email, city, shirt_type, shirt_size,
      registration_status, notes, reservation_status, reservation_expires_at, batch_id,
      base_amount, discount_amount, final_amount, ticket_category_id, user_id
    ) values (
      p_event_id,
      trim(p_buyer_full_name),
      regexp_replace(coalesce(p_buyer_cpf, ''), '\\D', '', 'g'),
      p_buyer_birth_date,
      trim(p_buyer_gender),
      regexp_replace(coalesce(p_buyer_phone, ''), '\\D', '', 'g'),
      lower(trim(p_buyer_email)),
      trim(p_buyer_city),
      coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), 'Sem camiseta'),
      coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), 'N/A'),
      case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      coalesce(nullif(trim(coalesce(p_notes, '')), ''), 'Anchor participante do checkout multi-ingressos'),
      case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      v_reservation_expires_at,
      v_batch_id,
      coalesce(v_pricing.base_amount, 0),
      coalesce(v_pricing.discount_amount, 0),
      coalesce(v_pricing.final_amount, 0),
      p_ticket_category_id,
      v_user_id
    ) returning id into v_anchor_participant_id;
  else
    perform public.apply_checkout_anchor_participant_update(
      v_anchor_participant_id,
      p_buyer_full_name,
      p_buyer_birth_date,
      p_buyer_gender,
      p_buyer_phone,
      p_buyer_email,
      p_buyer_city,
      p_shirt_type,
      p_shirt_size,
      v_payment_status,
      v_reservation_expires_at,
      v_batch_id,
      coalesce(v_pricing.base_amount, 0),
      coalesce(v_pricing.discount_amount, 0),
      coalesce(v_pricing.final_amount, 0),
      p_ticket_category_id
    );
  end if;

  v_order_number := public.generate_order_number();

  insert into public.orders (
    user_id, participant_id, event_id, payment_id, order_number, status,
    base_amount, discount_amount, final_amount, confirmed_at, cancelled_at, client_request_id
  ) values (
    v_user_id,
    v_anchor_participant_id,
    p_event_id,
    null,
    v_order_number,
    case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
    v_total_amount,
    v_total_discount,
    v_total_final,
    case when v_payment_status = 'paid' then now() else null end,
    null,
    nullif(trim(coalesce(p_client_request_id, '')), '')
  ) returning id into v_order_id;

  insert into public.payments (
    participant_id, event_id, amount, discount_amount, final_amount, payment_method,
    payment_status, paid_at, expires_at, order_id
  ) values (
    v_anchor_participant_id,
    p_event_id,
    v_total_amount,
    v_total_discount,
    v_total_final,
    trim(p_payment_method),
    v_payment_status,
    case when v_payment_status = 'paid' then now() else null end,
    v_reservation_expires_at,
    v_order_id
  ) returning id into v_payment_id;

  for v_item_index in 1..p_quantity loop
    v_item_payload := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_item_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;

    -- Fix (20260840000000): cada ingresso grava a PROPRIA camiseta/tamanho
    -- (v_item_payload), nao mais o parametro escalar de topo replicado pra
    -- todo o loop. O scalar p_shirt_type/p_shirt_size continua servindo de
    -- fallback quando o item nao especifica (fluxo de ingresso unico, que
    -- nunca populou p_items[i].shirt_type).
    v_item_shirt_type := nullif(trim(coalesce(v_item_payload ->> 'shirt_type', p_shirt_type, '')), '');
    v_item_shirt_size := nullif(trim(coalesce(v_item_payload ->> 'shirt_size', p_shirt_size, '')), '');

    -- Fix (20260846000000): mesma prioridade item->escalar ja usada pro
    -- calculo de preco (primeiro loop, v_item_gender) -- so que aqui o
    -- resultado e normalizado pros dois tokens canonicos ('male'/'female')
    -- e GRAVADO em order_items.pricing_gender, nunca descartado depois de
    -- calcular o preco. Um valor em formato inesperado vira null (nunca um
    -- terceiro token fora do check constraint) -- consistente com "nao
    -- inferir silenciosamente": se nao da pra reconhecer o genero, fica
    -- nao registrado, nao adivinhado.
    v_item_gender := lower(trim(coalesce(v_item_payload ->> 'pricing_gender', p_gender, '')));
    v_item_pricing_gender := case
      when v_item_gender in ('female', 'feminino', 'f') then 'female'
      when v_item_gender in ('male', 'masculino', 'm') then 'male'
      else null
    end;

    -- Fix (20260842000000): a checagem de "camiseta obrigatoria" antes deste
    -- loop so olhava pro item 1 (p_shirt_type/p_shirt_size escalares). Um
    -- payload com o item 1 preenchido e os itens 2..N sem shirt_type/
    -- shirt_size passava por ali sem erro e cada item 2..N nascia com o
    -- fallback pro escalar (bug 20260840000000) OU, se nem o escalar
    -- estivesse preenchido, com shirt_type/shirt_size null -- nunca
    -- rejeitado, mesmo o evento exigindo camiseta pra todo ingresso. Agora,
    -- pra evento com camiseta obrigatoria, CADA item resolvido sem
    -- shirt_type ou sem shirt_size aborta a transacao inteira (orders/
    -- payments ja inseridos nesta chamada sao desfeitos automaticamente),
    -- identificando o ingresso especifico na mensagem.
    if v_required_shirt and (v_item_shirt_type is null or v_item_shirt_size is null) then
      raise exception 'Camiseta obrigatoria para o ingresso %.', v_item_index;
    end if;

    v_ownership_status := lower(trim(coalesce(v_item_payload ->> 'ownership_status', case when p_assign_first_to_buyer and v_item_index = 1 then 'assigned' else 'unassigned' end)));
    v_holder_name := nullif(trim(coalesce(v_item_payload ->> 'holder_full_name', '')), '');
    v_holder_email := nullif(lower(trim(coalesce(v_item_payload ->> 'holder_email', ''))), '');
    v_holder_phone := nullif(regexp_replace(coalesce(v_item_payload ->> 'holder_phone', ''), '\\D', '', 'g'), '');

    if v_ownership_status not in ('unassigned', 'assigned', 'transferred', 'cancelled') then
      v_ownership_status := 'unassigned';
    end if;

    if v_ownership_status = 'assigned' and not (p_assign_first_to_buyer and v_item_index = 1) then
      v_ownership_status := 'unassigned';
    end if;

    insert into public.order_items (
      order_id, event_id, participant_id, ownership_status, ticket_category_id, batch_id,
      shirt_type, shirt_size, pricing_gender, quantity, unit_price, discount_amount, final_amount, status,
      reservation_expires_at, item_position, holder_full_name, holder_email, holder_phone
    ) values (
      v_order_id,
      p_event_id,
      case when p_assign_first_to_buyer and v_item_index = 1 and v_ownership_status = 'assigned' then v_anchor_participant_id else null end,
      case when p_assign_first_to_buyer and v_item_index = 1 and v_ownership_status = 'assigned' then 'assigned' else 'unassigned' end,
      p_ticket_category_id,
      v_batch_id,
      v_item_shirt_type,
      v_item_shirt_size,
      v_item_pricing_gender,
      1,
      v_item_bases[v_item_index],
      v_item_discounts[v_item_index],
      v_item_finals[v_item_index],
      v_status,
      v_reservation_expires_at,
      v_item_index,
      v_holder_name,
      v_holder_email,
      v_holder_phone
    );
  end loop;

  if coalesce(trim(coalesce(p_shirt_type, '')), '') <> '' and coalesce(trim(coalesce(p_shirt_size, '')), '') <> '' then
    update public.shirt_inventory
    set reserved_quantity = reserved_quantity + p_quantity,
        updated_at = now()
    where id = v_inventory.id;

    insert into public.inventory_movements (
      event_id, inventory_id, movement_type, quantity, notes
    ) values (
      p_event_id,
      v_inventory.id,
      'adjustment',
      -p_quantity,
      format('Reserva checkout multi (%s) pedido %s.', p_quantity, v_order_number)
    );
  end if;

  if coalesce(v_event.kit_enabled, false)
     and not public.participant_has_issued_event_ticket(v_anchor_participant_id) then
    insert into public.participant_kit_items (
      participant_id, event_id, kit_item_id, variant_data, quantity, status
    )
    select
      v_anchor_participant_id,
      p_event_id,
      eki.id,
      case
        when eki.item_type = 'shirt' then jsonb_build_object('shirt_type', coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), 'Sem camiseta'), 'shirt_size', coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), 'N/A'))
        else null
      end,
      eki.quantity_per_participant,
      case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end
    from public.event_kit_items eki
    where eki.event_id = p_event_id
      and eki.is_active = true
    on conflict (order_item_id, kit_item_id)
    do update set
      quantity = excluded.quantity,
      status = excluded.status,
      variant_data = excluded.variant_data;
  end if;

  if v_payment_status = 'paid' then
    perform public.confirm_order_payment_and_issue_tickets(v_order_id);
  end if;

  return query
  select
    v_order_id,
    v_payment_id,
    v_order_number,
    v_payment_status,
    v_reservation_expires_at,
    p_quantity,
    v_total_amount,
    v_total_discount,
    v_total_final;
end;
$function$;

revoke all on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text, text, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text, text, jsonb)
to authenticated;

commit;
