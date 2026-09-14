-- Expiracao operacional do PIX usa o prazo comercial (dueDate), nao o
-- expirationDate longo do QR Asaas (~1 ano) que ficou persistido em
-- payments.expires_at em registros legados.
--
-- Fonte primaria (cobrancas novas): asaas-provider ja grava
-- min(QR expirationDate, dueDate 23:59:59 America/Sao_Paulo).
-- Fallback legado: se expires_at >= created_at + 30 dias, o valor e o
-- artefato do QR; o dueDate comercial e o dia civil de created_at em
-- America/Sao_Paulo (o mesmo todayAsPixDueDate() enviado na criacao).
-- Cartao e demais metodos: expires_at persistido, sem fallback.
--
-- Nao cancela a cobranca no Asaas. O dueDate comercial ja venceu no
-- gateway; pagamento tardio continua em apply_gateway_payment_status
-- (payment_paid_after_<status>, sem reemitir ingresso).
-- Nao faz UPDATE em massa de expires_at: o cron expire_stale (2 min)
-- passa a selecionar pela data comercial e chama
-- _apply_terminal_order_payment_status('expired'), que ja libera reserva.

create or replace function public.pix_commercial_expires_at(
  p_payment_method text,
  p_expires_at timestamptz,
  p_created_at timestamptz
)
returns timestamptz
language sql
stable
parallel safe
as $$
  select case
    when p_expires_at is null then null
    when lower(coalesce(p_payment_method, '')) <> 'pix' then p_expires_at
    when p_created_at is null then p_expires_at
    when p_expires_at < p_created_at + interval '30 days' then p_expires_at
    else ((timezone('America/Sao_Paulo', p_created_at))::date + time '23:59:59')
         at time zone 'America/Sao_Paulo'
  end;
$$;

comment on function public.pix_commercial_expires_at(text, timestamptz, timestamptz) is
  'Prazo comercial do pagamento. PIX: expires_at persistido, salvo artefato de QR (>= 30d apos created_at), caso em que usa fim do dia civil de created_at em America/Sao_Paulo. Cartao: expires_at cru.';

revoke all on function public.pix_commercial_expires_at(text, timestamptz, timestamptz) from public;
grant execute on function public.pix_commercial_expires_at(text, timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.expire_stale_order_payments(p_organization_id uuid default null)
returns integer
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_actor uuid := auth.uid();
  v_payment_id uuid;
  v_count integer := 0;
begin
  if v_actor is not null then
    if p_organization_id is null then
      raise exception 'organization_id obrigatorio para execucao manual.';
    end if;
    if not (public.current_user_has_permission('orders.cancel') and public.user_can_access_organization(v_actor, p_organization_id)) then
      raise exception 'Sem permissao para expirar pedidos desta organizacao.';
    end if;
  end if;

  for v_payment_id in
    select p.id from public.payments p
    where p.payment_status = 'pending'
      and p.order_id is not null
      and p.expires_at is not null
      and public.pix_commercial_expires_at(p.payment_method, p.expires_at, p.created_at) <= now()
      and (p_organization_id is null or p.organization_id = p_organization_id)
    order by public.pix_commercial_expires_at(p.payment_method, p.expires_at, p.created_at)
    for update skip locked
  loop
    perform public._apply_terminal_order_payment_status(v_payment_id, 'expired');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.expire_stale_order_payments(uuid) from public;
grant execute on function public.expire_stale_order_payments(uuid) to authenticated, service_role;

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
  v_commercial := public.pix_commercial_expires_at(v_payment.payment_method, v_payment.expires_at, v_payment.created_at);
  if v_commercial is not null and v_commercial <= now() then
    raise exception 'Prazo comercial do pagamento expirado.';
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
      expires_at = p_expires_at,
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

revoke all on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text, text, jsonb)
from public, anon, authenticated, service_role;
grant execute on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text, text, jsonb)
to authenticated;

create or replace function public.claim_order_pix_generation(p_order_id uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_has_charges boolean;
  v_has_live boolean;
  v_previous_ids jsonb;
  v_commercial timestamptz;
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

  if v_order.status <> 'pending' then
    raise exception 'Pedido nao esta mais no carrinho (status atual: %).', v_order.status;
  end if;
  if v_payment.payment_status in ('expired', 'cancelled', 'refunded') then
    raise exception 'Pagamento nao pode mais ser gerado.';
  end if;

  v_commercial := public.pix_commercial_expires_at(v_payment.payment_method, v_payment.expires_at, v_payment.created_at);

  select exists (
    select 1 from public.payment_gateway_charges c where c.payment_id = v_payment.id
  ) into v_has_charges;

  select exists (
    select 1 from public.payment_gateway_charges c
    where c.payment_id = v_payment.id and c.reusable and not c.deleted
  ) into v_has_live;

  if v_payment.payment_status = 'pending'
    and coalesce(v_payment.gateway_payment_id, '') <> ''
    and v_commercial is not null
    and v_commercial > now()
    and (
      (v_has_charges and v_has_live)
      or (not v_has_charges)
    ) then
    return jsonb_build_object(
      'action', 'reuse',
      'payment_id', v_payment.id,
      'gateway_payment_id', v_payment.gateway_payment_id
    );
  end if;

  if v_commercial is not null and v_commercial <= now() then
    raise exception 'Prazo comercial do pagamento expirado.';
  end if;

  if v_payment.pix_generation_started_at is not null
    and v_payment.pix_generation_started_at > now() - interval '45 seconds' then
    raise exception 'PIX_GENERATION_IN_PROGRESS';
  end if;

  select coalesce(jsonb_agg(c.gateway_payment_id), '[]'::jsonb)
  into v_previous_ids
  from public.payment_gateway_charges c
  where c.payment_id = v_payment.id
    and not c.deleted;

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
    'previous_gateway_account_key', v_payment.gateway_account_key,
    'previous_gateway_installment_id', v_payment.gateway_installment_id,
    'previous_gateway_payment_ids', v_previous_ids
  );
end;
$$;

revoke all on function public.claim_order_pix_generation(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_order_pix_generation(uuid) to authenticated;
