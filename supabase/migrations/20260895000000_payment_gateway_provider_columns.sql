begin;

-- Fase 1 Asaas -- fundacao canonica de pagamentos reais. Esta migration
-- prepara `payments` para um gateway real generico (Asaas e futuros), sem
-- ativar nenhuma cobranca real e sem tocar no checkout publico:
--
--   1. novas colunas descritivas do provider (provider, provider_status,
--      provider_customer_id, installments, fee_amount, net_amount,
--      refunded_at, metadata);
--   2. constraint de unicidade da cobranca externa -- reaproveita
--      `gateway_payment_id` (ja existente) em vez de duplicar a coluna,
--      conforme decisao da auditoria ("provider_payment_id ou reutilizacao
--      segura de gateway_payment_id");
--   3. `start_order_payment_pix`/`start_payment_pix` passam a registrar qual
--      provider gerou a cobranca (parametro novo com DEFAULT -- nenhum call
--      site em src/ precisa mudar).
--
-- cash/courtesy e pagamentos legados continuam com provider/gateway_payment_id
-- nulos -- a constraint e parcial (WHERE gateway_payment_id IS NOT NULL) e
-- nao afeta esses casos.

alter table public.payments
  add column if not exists provider text,
  add column if not exists provider_status text,
  add column if not exists provider_customer_id text,
  add column if not exists installments integer,
  add column if not exists fee_amount numeric(10,2),
  add column if not exists net_amount numeric(10,2),
  add column if not exists refunded_at timestamptz,
  add column if not exists metadata jsonb;

alter table public.payments
  add constraint payments_provider_check check (provider is null or provider in ('fake','asaas')),
  add constraint payments_installments_check check (installments is null or installments >= 1),
  add constraint payments_fee_amount_check check (fee_amount is null or fee_amount >= 0),
  add constraint payments_net_amount_check check (net_amount is null or net_amount >= 0);

-- Backfill conservador: todo pagamento pix ja existente com gateway_payment_id
-- preenchido foi gerado pelo FakePaymentProvider (unico provider real em uso
-- ate hoje -- MercadoPagoProvider e um stub que sempre lanca excecao antes de
-- chegar aqui, confirmado na auditoria).
update public.payments
set provider = 'fake'
where gateway_payment_id is not null and provider is null;

-- Impede que a mesma cobranca externa (provider, gateway_payment_id) seja
-- vinculada a dois pagamentos internos diferentes. Parcial: nao se aplica a
-- cash/courtesy/legado sem gateway_payment_id.
create unique index if not exists ux_payments_provider_gateway_payment_id
  on public.payments (provider, gateway_payment_id)
  where gateway_payment_id is not null;

create index if not exists idx_payments_provider_status
  on public.payments (provider, provider_status)
  where provider is not null;

comment on column public.payments.provider is 'Gateway que originou a cobranca externa (null = cash/courtesy/sem gateway). Ver src/lib/payments/provider.ts:PaymentProviderName.';
comment on column public.payments.provider_status is 'Ultimo status cru retornado pelo gateway (ex.: CONFIRMED, OVERDUE). Somente para auditoria/depuracao -- nunca interpretar fora de mapAsaasPaymentStatus.';
comment on column public.payments.gateway_payment_id is 'Id da cobranca no gateway externo. Par (provider, gateway_payment_id) e UNIQUE via ux_payments_provider_gateway_payment_id.';

-- CREATE OR REPLACE nao substitui uma funcao quando a lista de parametros
-- muda de aridade (5 -> 6) -- ficaria um overload novo ao lado do antigo.
-- Precisa dropar a assinatura antiga explicitamente antes de recriar.
drop function if exists public.start_order_payment_pix(uuid, text, text, text, timestamptz);
drop function if exists public.start_payment_pix(uuid, text, text, text, timestamptz);

create or replace function public.start_order_payment_pix(
  p_order_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz,
  p_provider text default 'fake'
)
returns table(payment_id uuid, order_id uuid, event_id uuid, amount numeric, discount_amount numeric, final_amount numeric, payment_method text, payment_status text, pix_code text, pix_qrcode text, gateway_payment_id text, expires_at timestamptz, paid_at timestamptz)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
  end if;

  if p_provider is not null and p_provider not in ('fake','asaas') then
    raise exception 'Provider de pagamento invalido.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;

  if auth.uid() is not null and auth.uid() <> v_order.user_id then
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
      v_payment.expires_at, v_payment.paid_at;
    return;
  end if;

  update public.payments
  set payment_method = 'pix',
      payment_status = 'pending',
      pix_code = p_pix_code,
      pix_qrcode = p_pix_qrcode,
      gateway_payment_id = p_gateway_payment_id,
      provider = coalesce(p_provider, 'fake'),
      provider_status = null,
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
    and status not in ('cancelled', 'expired', 'refunded', 'transferred');

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
    v_payment.expires_at, v_payment.paid_at;
end;
$$;

create or replace function public.start_payment_pix(
  p_participant_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz,
  p_provider text default 'fake'
)
returns table(payment_id uuid, participant_id uuid, event_id uuid, amount numeric, discount_amount numeric, final_amount numeric, payment_method text, payment_status text, pix_code text, pix_qrcode text, gateway_payment_id text, expires_at timestamptz, paid_at timestamptz)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
begin
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
  end if;

  if p_provider is not null and p_provider not in ('fake','asaas') then
    raise exception 'Provider de pagamento invalido.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  select * into v_payment
  from public.payments pay
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o participante.';
  end if;

  if v_payment.payment_status = 'paid' then
    return query
    select
      v_payment.id, v_payment.participant_id, v_payment.event_id, v_payment.amount,
      coalesce(v_payment.discount_amount, 0), coalesce(v_payment.final_amount, v_payment.amount),
      v_payment.payment_method, v_payment.payment_status,
      v_payment.pix_code, v_payment.pix_qrcode, v_payment.gateway_payment_id,
      v_payment.expires_at, v_payment.paid_at;
    return;
  end if;

  update public.payments
  set payment_method = 'pix',
      payment_status = 'pending',
      pix_code = p_pix_code,
      pix_qrcode = p_pix_qrcode,
      gateway_payment_id = p_gateway_payment_id,
      provider = coalesce(p_provider, 'fake'),
      provider_status = null,
      expires_at = p_expires_at,
      paid_at = null
  where id = v_payment.id
  returning * into v_payment;

  update public.participants
  set registration_status = 'pending',
      reservation_status = 'pending',
      reservation_expires_at = p_expires_at,
      updated_at = now()
  where id = p_participant_id
    and reservation_status <> 'confirmed';

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'payment_pix_started',
    'payments',
    v_payment.id,
    jsonb_build_object(
      'participant_id', p_participant_id,
      'expires_at', p_expires_at,
      'gateway_payment_id', p_gateway_payment_id,
      'provider', coalesce(p_provider, 'fake')
    ),
    v_participant.event_id
  );

  return query
  select
    v_payment.id, v_payment.participant_id, v_payment.event_id, v_payment.amount,
    coalesce(v_payment.discount_amount, 0), coalesce(v_payment.final_amount, v_payment.amount),
    v_payment.payment_method, v_payment.payment_status,
    v_payment.pix_code, v_payment.pix_qrcode, v_payment.gateway_payment_id,
    v_payment.expires_at, v_payment.paid_at;
end;
$$;

revoke all on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text) from public;
grant all on function public.start_order_payment_pix(uuid, text, text, text, timestamptz, text) to anon, authenticated, service_role;

revoke all on function public.start_payment_pix(uuid, text, text, text, timestamptz, text) from public;
grant all on function public.start_payment_pix(uuid, text, text, text, timestamptz, text) to anon, authenticated, service_role;

commit;
