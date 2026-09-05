begin;

-- Blockers da homologacao sandbox de cartao Asaas (migration 51 ainda local).
-- 1) N gateway charges por 1 payment comercial (parcelamento).
-- 2) Unique de cobranca inclui account_key.
-- 3) CAPTURE_REFUSED e tentativa, nao falha comercial.
-- 4) Cobranca deletada nao e reutilizada.
-- Semantica: ingresso emite na APROVACAO do cartao (PAYMENT_CONFIRMED /
-- PAYMENT_RECEIVED em qualquer parcela), nao no recebimento de todas as
-- parcelas futuras.

-- ============================================================
-- 1) Colunas no payment comercial
-- ============================================================
alter table public.payments
  add column if not exists last_gateway_attempt_status text,
  add column if not exists gateway_installment_id text;

alter table public.payments
  drop constraint if exists payments_last_gateway_attempt_status_check;

alter table public.payments
  add constraint payments_last_gateway_attempt_status_check
  check (last_gateway_attempt_status is null or last_gateway_attempt_status = 'refused');

comment on column public.payments.last_gateway_attempt_status is
  'Ultima tentativa de captura na invoice hospedada. refused = cartao recusado; payment_status permanece pending. Null apos aprovacao ou nova cobranca.';

comment on column public.payments.gateway_installment_id is
  'Id do parcelamento Asaas (installment) quando a cobranca comercial gerou N payments no gateway. Null para PIX e cartao 1x.';

-- ============================================================
-- 2) Unique de payments.gateway_payment_id inclui conta.
-- Legado sem account_key continua coalesce vazio, equivalente ao unique
-- antigo (provider, gateway_payment_id) para Gate #1.
-- ============================================================
drop index if exists public.ux_payments_provider_gateway_payment_id;

create unique index if not exists ux_payments_provider_account_gateway_payment_id
  on public.payments (provider, coalesce(gateway_account_key, ''), gateway_payment_id)
  where gateway_payment_id is not null;

comment on column public.payments.gateway_payment_id is
  'Id primario da cobranca no gateway (PIX ou primeira parcela). Unicidade: (provider, account_key, gateway_payment_id). Parcelas adicionais vivem em payment_gateway_charges.';

-- ============================================================
-- 3) Cobrancas de gateway pertencentes a um payment comercial
-- ============================================================
create table if not exists public.payment_gateway_charges (
  id uuid default gen_random_uuid() not null primary key,
  payment_id uuid not null references public.payments(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  provider text not null,
  gateway_account_key text,
  gateway_payment_id text not null,
  gateway_installment_id text,
  installment_number integer,
  installment_count integer,
  amount numeric,
  gateway_status text,
  deleted boolean not null default false,
  reusable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_gateway_charges_provider_check check (provider in ('fake', 'asaas')),
  constraint payment_gateway_charges_installment_number_check
    check (installment_number is null or installment_number >= 1),
  constraint payment_gateway_charges_installment_count_check
    check (installment_count is null or installment_count >= 1)
);

comment on table public.payment_gateway_charges is
  'Cobrancas externas (pay_) de um payment comercial. Parcelamento Asaas: 1 installment, N charges, 1 order/ticket.';

create unique index if not exists ux_payment_gateway_charges_provider_account_pay
  on public.payment_gateway_charges (provider, coalesce(gateway_account_key, ''), gateway_payment_id);

create index if not exists idx_payment_gateway_charges_payment_id
  on public.payment_gateway_charges (payment_id);

create index if not exists idx_payment_gateway_charges_installment
  on public.payment_gateway_charges (provider, gateway_installment_id)
  where gateway_installment_id is not null;

alter table public.payment_gateway_charges enable row level security;

revoke all on table public.payment_gateway_charges from public, anon, authenticated;
grant all on table public.payment_gateway_charges to postgres, service_role;

-- ============================================================
-- 4) apply_gateway_payment_status: lookup por charge + evento
-- ============================================================
drop function if exists public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric, text);

create or replace function public.apply_gateway_payment_status(
  p_provider text,
  p_provider_payment_id text,
  p_provider_status text,
  p_internal_status text,
  p_paid_at timestamptz default null,
  p_fee_amount numeric default null,
  p_net_amount numeric default null,
  p_expected_gateway_account_key text default null,
  p_event_type text default null
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
    -- Carrinho que anulou gateway_payment_id, charge supersedida ou deletada
    -- nao atualiza o payment comercial. Parcelas do installment vigente sim.
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

  -- Recusa de captura: invoice continua utilizavel; payment comercial pending.
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

  -- Cobranca apagada no gateway: nao reutilizar invoice; pedido permanece pending.
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

revoke all on function public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric, text, text)
from public, anon, authenticated;
grant execute on function public.apply_gateway_payment_status(text, text, text, text, timestamptz, numeric, numeric, text, text)
to service_role;

-- ============================================================
-- 5) Persistencia de charges no start_order_payment_pix
-- ============================================================
drop function if exists public.start_order_payment_pix(uuid, text, text, text, timestamptz, text, text, text, text);

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

-- ============================================================
-- 6) Claim: so reutiliza charge viva (nao deletada)
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
  v_has_charges boolean;
  v_has_live boolean;
  v_previous_ids jsonb;
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

  select exists (
    select 1 from public.payment_gateway_charges c where c.payment_id = v_payment.id
  ) into v_has_charges;

  select exists (
    select 1 from public.payment_gateway_charges c
    where c.payment_id = v_payment.id and c.reusable and not c.deleted
  ) into v_has_live;

  if v_payment.payment_status = 'pending'
    and coalesce(v_payment.gateway_payment_id, '') <> ''
    and v_payment.expires_at is not null
    and v_payment.expires_at > now()
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

-- ============================================================
-- 7) Marcar charges como nao reutilizaveis apos cancel local/remoto
-- ============================================================
create or replace function public.mark_gateway_charges_not_reusable(
  p_payment_id uuid,
  p_gateway_payment_id text default null
)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_payment public.payments%rowtype;
begin
  if p_payment_id is null then
    raise exception 'payment_id obrigatorio.';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'Pagamento nao encontrado.';
  end if;

  if v_actor is not null then
    if not exists (
      select 1 from public.orders o
      where o.id = v_payment.order_id and o.user_id = v_actor
    ) then
      raise exception 'Sem permissao para alterar pagamento deste pedido.';
    end if;
  end if;

  update public.payment_gateway_charges
  set reusable = false,
      deleted = true,
      gateway_status = coalesce(gateway_status, 'CANCELLED'),
      updated_at = now()
  where payment_gateway_charges.payment_id = p_payment_id
    and (
      p_gateway_payment_id is null
      or payment_gateway_charges.gateway_payment_id = p_gateway_payment_id
    );
end;
$$;

revoke all on function public.mark_gateway_charges_not_reusable(uuid, text) from public, anon;
grant execute on function public.mark_gateway_charges_not_reusable(uuid, text) to authenticated, service_role;

create or replace function public.list_live_gateway_charge_ids(p_payment_id uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_payment public.payments%rowtype;
  v_ids jsonb;
begin
  if p_payment_id is null then
    raise exception 'payment_id obrigatorio.';
  end if;

  select * into v_payment from public.payments where id = p_payment_id;
  if not found then
    raise exception 'Pagamento nao encontrado.';
  end if;

  if v_actor is not null then
    if not exists (
      select 1 from public.orders o
      where o.id = v_payment.order_id and o.user_id = v_actor
    ) then
      raise exception 'Sem permissao para consultar pagamento deste pedido.';
    end if;
  end if;

  select coalesce(jsonb_agg(c.gateway_payment_id), '[]'::jsonb)
  into v_ids
  from public.payment_gateway_charges c
  where c.payment_id = p_payment_id
    and not c.deleted;

  return v_ids;
end;
$$;

revoke all on function public.list_live_gateway_charge_ids(uuid) from public, anon;
grant execute on function public.list_live_gateway_charge_ids(uuid) to authenticated, service_role;

-- ============================================================
-- 8) Snapshot expoe tentativa recusada e se a cobranca e reutilizavel
-- ============================================================
create or replace function public.get_cart_order_details(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_event public.events%rowtype;
  v_payment public.payments%rowtype; v_items jsonb;
  v_charge_reusable boolean;
  v_has_charges boolean;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  select * into v_event from public.events where id = v_order.event_id;
  select * into v_payment from public.payments where order_id = p_order_id order by created_at desc limit 1;

  select exists (select 1 from public.payment_gateway_charges c where c.payment_id = v_payment.id)
  into v_has_charges;
  select exists (
    select 1 from public.payment_gateway_charges c
    where c.payment_id = v_payment.id and c.reusable and not c.deleted
  ) into v_charge_reusable;
  if v_payment.id is not null and not v_has_charges then
    v_charge_reusable := coalesce(v_payment.gateway_payment_id, '') <> '';
  end if;

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
      'payment_fee_organizer_amount', v_payment.payment_fee_organizer_amount,
      'last_gateway_attempt_status', v_payment.last_gateway_attempt_status,
      'gateway_charge_reusable', coalesce(v_charge_reusable, false),
      'gateway_installment_id', v_payment.gateway_installment_id
    ) end,
    'items', v_items
  );
end; $$;

commit;
