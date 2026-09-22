-- Pagamento recebido fora do gateway integrado.
-- Distingue natureza financeira (gateway / off_gateway / courtesy / coupon_zero / legacy)
-- sem reutilizar `cash` e sem usar payment_method=pix como prova de Asaas.
-- Nao cria gateway_payment_id ficticio, nao dispara webhook, nao emite ingresso.
begin;

alter table public.payments
  add column if not exists settlement_nature text,
  add column if not exists off_gateway_method text,
  add column if not exists off_gateway_amount numeric(12,2),
  add column if not exists off_gateway_received_at timestamptz,
  add column if not exists off_gateway_recorded_at timestamptz,
  add column if not exists off_gateway_recorded_by uuid references auth.users(id),
  add column if not exists off_gateway_reason text,
  add column if not exists off_gateway_reference text,
  add column if not exists off_gateway_destination_note text;

alter table public.payments drop constraint if exists payments_settlement_nature_check;
alter table public.payments add constraint payments_settlement_nature_check
  check (settlement_nature is null or settlement_nature in ('gateway','off_gateway','courtesy','coupon_zero','legacy'));

alter table public.payments drop constraint if exists payments_off_gateway_method_check;
alter table public.payments add constraint payments_off_gateway_method_check
  check (off_gateway_method is null or off_gateway_method in ('pix'));

alter table public.payments drop constraint if exists payments_off_gateway_amount_check;
alter table public.payments add constraint payments_off_gateway_amount_check
  check (off_gateway_amount is null or off_gateway_amount > 0);

comment on column public.payments.settlement_nature is
  'Natureza financeira canonica. Independente de payment_method historico.';
comment on column public.payments.off_gateway_method is
  'Meio real do dinheiro recebido fora do gateway. Nesta versao: pix.';
comment on column public.payments.off_gateway_amount is
  'Valor efetivamente recebido fora do gateway. Nao altera amount/discount/final_amount da emissao.';
comment on column public.payments.off_gateway_destination_note is
  'Texto livre opcional (ex.: outra conta). Nao armazena dado bancario sensivel.';

create or replace function public.payment_has_real_gateway_charge(
  p_provider text,
  p_gateway_payment_id text,
  p_gateway_account_key text,
  p_gateway_environment text
) returns boolean
language sql
immutable
as $$
  select
    nullif(trim(coalesce(p_gateway_payment_id, '')), '') is not null
    and lower(trim(p_gateway_payment_id)) not like 'fake_%'
    and lower(trim(coalesce(p_provider, ''))) is distinct from 'fake'
    and (
      lower(trim(coalesce(p_provider, ''))) = 'asaas'
      or lower(trim(coalesce(p_gateway_environment, ''))) in ('production', 'sandbox')
      or trim(coalesce(p_gateway_account_key, '')) in ('asaas-conta-live-01', 'asaas-sandbox-militrin')
    );
$$;

create or replace function public.derive_payment_settlement_nature(
  p_payment_method text,
  p_price_origin text,
  p_provider text,
  p_gateway_payment_id text,
  p_gateway_account_key text,
  p_gateway_environment text,
  p_amount numeric,
  p_discount_amount numeric,
  p_final_amount numeric,
  p_off_gateway_recorded_at timestamptz
) returns text
language plpgsql
immutable
as $$
declare
  v_method text := lower(trim(coalesce(p_payment_method, '')));
  v_amount numeric := coalesce(p_amount, 0);
  v_discount numeric := coalesce(p_discount_amount, 0);
  v_final numeric := coalesce(p_final_amount, 0);
  v_has_gateway boolean;
begin
  if p_off_gateway_recorded_at is not null then
    return 'off_gateway';
  end if;
  v_has_gateway := public.payment_has_real_gateway_charge(
    p_provider, p_gateway_payment_id, p_gateway_account_key, p_gateway_environment
  );
  if v_has_gateway then
    return 'gateway';
  end if;
  if v_method in ('courtesy', 'admin_courtesy') then
    return 'courtesy';
  end if;
  if coalesce(p_price_origin, '') in ('legacy_unknown', 'legacy_provided') then
    return 'legacy';
  end if;
  if v_final <= 0 and v_discount > 0 and v_discount >= v_amount then
    return 'coupon_zero';
  end if;
  if v_method in ('pix', 'credit_card', 'cash') and v_final > 0 then
    return 'legacy';
  end if;
  return null;
end;
$$;

create or replace function public.payments_settlement_nature_before_write()
returns trigger
language plpgsql
as $$
begin
  new.settlement_nature := public.derive_payment_settlement_nature(
    new.payment_method,
    new.price_origin,
    new.provider,
    new.gateway_payment_id,
    new.gateway_account_key,
    new.gateway_environment,
    new.amount,
    new.discount_amount,
    new.final_amount,
    new.off_gateway_recorded_at
  );
  return new;
end;
$$;

drop trigger if exists trg_payments_settlement_nature on public.payments;
create trigger trg_payments_settlement_nature
before insert or update of
  payment_method, price_origin, provider, gateway_payment_id, gateway_account_key, gateway_environment,
  amount, discount_amount, final_amount, off_gateway_recorded_at, settlement_nature
on public.payments
for each row
execute function public.payments_settlement_nature_before_write();

update public.payments as p
set settlement_nature = public.derive_payment_settlement_nature(
  p.payment_method,
  p.price_origin,
  p.provider,
  p.gateway_payment_id,
  p.gateway_account_key,
  p.gateway_environment,
  p.amount,
  p.discount_amount,
  p.final_amount,
  p.off_gateway_recorded_at
)
where p.settlement_nature is null;

create index if not exists idx_payments_settlement_nature
  on public.payments (settlement_nature);

create or replace function public.regularize_off_gateway_payment(
  p_payment_id uuid,
  p_method text,
  p_amount_received numeric,
  p_received_at timestamptz,
  p_reason text,
  p_reference text default null,
  p_destination_note text default null,
  p_replace boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_payment public.payments%rowtype;
  v_order public.orders%rowtype;
  v_method text := lower(trim(coalesce(p_method, '')));
  v_reason text := trim(coalesce(p_reason, ''));
  v_reference text := nullif(trim(coalesce(p_reference, '')), '');
  v_destination text := nullif(trim(coalesce(p_destination_note, '')), '');
  v_amount numeric;
  v_same boolean := false;
  v_previous jsonb;
  v_new jsonb;
begin
  if v_actor is null then
    raise exception 'Usuario nao autenticado.';
  end if;
  if not (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor, 'finance.confirm_payment')) then
    raise exception 'Sem permissao para confirmar pagamentos.';
  end if;
  if v_method <> 'pix' then
    raise exception 'METHOD_INVALID: nesta versao so e permitido PIX fora do gateway.';
  end if;
  if p_amount_received is null or p_amount_received <= 0 then
    raise exception 'AMOUNT_RECEIVED_INVALID: o valor recebido deve ser maior que zero.';
  end if;
  v_amount := round(p_amount_received, 2);
  if v_amount <= 0 then
    raise exception 'AMOUNT_RECEIVED_INVALID: o valor recebido deve ser maior que zero.';
  end if;
  if p_received_at is null then
    raise exception 'RECEIVED_AT_REQUIRED: a data e hora do recebimento sao obrigatorias.';
  end if;
  if v_reason = '' then
    raise exception 'REASON_REQUIRED: o motivo e obrigatorio.';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'PAYMENT_NOT_FOUND: pagamento nao encontrado.';
  end if;
  if not public.user_can_access_organization(v_actor, v_payment.organization_id) then
    raise exception 'Sem acesso a organizacao do pagamento.';
  end if;

  select * into v_order from public.orders
  where id = coalesce(v_payment.order_id, (select o.id from public.orders o where o.payment_id = v_payment.id limit 1))
  for update;

  if public.payment_has_real_gateway_charge(
    v_payment.provider, v_payment.gateway_payment_id, v_payment.gateway_account_key, v_payment.gateway_environment
  ) then
    raise exception 'GATEWAY_LIVE_PAYMENT: este pagamento tem cobranca no gateway integrado e nao pode ser convertido para fora do gateway.';
  end if;

  if coalesce(v_payment.settlement_nature, public.derive_payment_settlement_nature(
    v_payment.payment_method, v_payment.price_origin, v_payment.provider, v_payment.gateway_payment_id,
    v_payment.gateway_account_key, v_payment.gateway_environment, v_payment.amount, v_payment.discount_amount,
    v_payment.final_amount, v_payment.off_gateway_recorded_at
  )) = 'coupon_zero' then
    raise exception 'COUPON_ZERO_NOT_OFF_GATEWAY: cupom 100%% nao e pagamento recebido fora do gateway.';
  end if;

  if v_payment.payment_status is distinct from 'paid' then
    raise exception 'PENDING_OFF_GATEWAY_NOT_IMPLEMENTED: regularizacao fora do gateway nesta versao so se aplica a pagamento ja pago, sem emitir ingresso.';
  end if;

  v_same :=
    v_payment.settlement_nature = 'off_gateway'
    and v_payment.off_gateway_recorded_at is not null
    and lower(trim(coalesce(v_payment.off_gateway_method, ''))) = v_method
    and round(coalesce(v_payment.off_gateway_amount, 0), 2) = v_amount
    and v_payment.off_gateway_received_at is not distinct from p_received_at
    and trim(coalesce(v_payment.off_gateway_reason, '')) = v_reason
    and nullif(trim(coalesce(v_payment.off_gateway_reference, '')), '') is not distinct from v_reference;

  if v_same then
    return jsonb_build_object(
      'success', true,
      'idempotent', true,
      'replaced', false,
      'payment_id', v_payment.id,
      'order_id', v_order.id,
      'settlement_nature', 'off_gateway',
      'off_gateway_method', v_method,
      'off_gateway_amount', v_amount,
      'off_gateway_received_at', v_payment.off_gateway_received_at,
      'message', 'Regularizacao fora do gateway ja registrada com os mesmos dados.'
    );
  end if;

  if v_payment.settlement_nature = 'off_gateway' and v_payment.off_gateway_recorded_at is not null and not coalesce(p_replace, false) then
    raise exception 'OFF_GATEWAY_ALREADY_RECORDED: este pagamento ja possui regularizacao fora do gateway. Confirme a substituicao explicita.';
  end if;

  v_previous := jsonb_build_object(
    'settlement_nature', v_payment.settlement_nature,
    'payment_method', v_payment.payment_method,
    'payment_status', v_payment.payment_status,
    'amount', v_payment.amount,
    'discount_amount', v_payment.discount_amount,
    'final_amount', v_payment.final_amount,
    'provider', v_payment.provider,
    'gateway_payment_id', v_payment.gateway_payment_id,
    'off_gateway_method', v_payment.off_gateway_method,
    'off_gateway_amount', v_payment.off_gateway_amount,
    'off_gateway_received_at', v_payment.off_gateway_received_at,
    'off_gateway_recorded_at', v_payment.off_gateway_recorded_at,
    'off_gateway_recorded_by', v_payment.off_gateway_recorded_by,
    'off_gateway_reason', v_payment.off_gateway_reason,
    'off_gateway_reference', v_payment.off_gateway_reference,
    'off_gateway_destination_note', v_payment.off_gateway_destination_note,
    'buyer_type', v_order.buyer_type
  );

  update public.payments
  set
    off_gateway_method = v_method,
    off_gateway_amount = v_amount,
    off_gateway_received_at = p_received_at,
    off_gateway_recorded_at = now(),
    off_gateway_recorded_by = v_actor,
    off_gateway_reason = v_reason,
    off_gateway_reference = v_reference,
    off_gateway_destination_note = v_destination,
    updated_at = now()
  where id = v_payment.id
  returning * into v_payment;

  v_new := jsonb_build_object(
    'settlement_nature', v_payment.settlement_nature,
    'payment_method', v_payment.payment_method,
    'payment_status', v_payment.payment_status,
    'amount', v_payment.amount,
    'discount_amount', v_payment.discount_amount,
    'final_amount', v_payment.final_amount,
    'provider', v_payment.provider,
    'gateway_payment_id', v_payment.gateway_payment_id,
    'off_gateway_method', v_payment.off_gateway_method,
    'off_gateway_amount', v_payment.off_gateway_amount,
    'off_gateway_received_at', v_payment.off_gateway_received_at,
    'off_gateway_recorded_at', v_payment.off_gateway_recorded_at,
    'off_gateway_recorded_by', v_payment.off_gateway_recorded_by,
    'off_gateway_reason', v_payment.off_gateway_reason,
    'off_gateway_reference', v_payment.off_gateway_reference,
    'off_gateway_destination_note', v_payment.off_gateway_destination_note
  );

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values (
    'off_gateway_payment_regularized',
    'payments',
    v_payment.id,
    v_payment.event_id,
    jsonb_build_object(
      'payment_id', v_payment.id,
      'order_id', v_order.id,
      'previous', v_previous,
      'new', v_new,
      'received_at', p_received_at,
      'recorded_by', v_actor,
      'reason', v_reason,
      'reference', v_reference,
      'timestamp', now(),
      'replaced', coalesce(p_replace, false) and (v_previous->>'settlement_nature') = 'off_gateway',
      'ticket_mutated', false,
      'gateway_payment_id_created', false
    )
  );

  return jsonb_build_object(
    'success', true,
    'idempotent', false,
    'replaced', coalesce(p_replace, false) and (v_previous->>'settlement_nature') = 'off_gateway',
    'payment_id', v_payment.id,
    'order_id', v_order.id,
    'settlement_nature', v_payment.settlement_nature,
    'off_gateway_method', v_payment.off_gateway_method,
    'off_gateway_amount', v_payment.off_gateway_amount,
    'off_gateway_received_at', v_payment.off_gateway_received_at,
    'off_gateway_recorded_at', v_payment.off_gateway_recorded_at,
    'off_gateway_recorded_by', v_payment.off_gateway_recorded_by,
    'message', 'Pagamento fora do gateway registrado. Ingressos nao foram alterados.'
  );
end;
$$;

revoke all on function public.regularize_off_gateway_payment(uuid, text, numeric, timestamptz, text, text, text, boolean)
  from public, anon;
grant execute on function public.regularize_off_gateway_payment(uuid, text, numeric, timestamptz, text, text, text, boolean)
  to authenticated, service_role;

comment on function public.regularize_off_gateway_payment(uuid, text, numeric, timestamptz, text, text, text, boolean) is
  'Registra dinheiro real recebido fora do gateway. Nao emite/altera ticket, nao cria cobranca Asaas. Permissao: finance.confirm_payment.';

commit;
