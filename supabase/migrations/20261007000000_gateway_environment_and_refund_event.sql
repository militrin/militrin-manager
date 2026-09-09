-- Distincao tecnica sandbox vs production (LIVE na UI) e correcao do
-- webhook de estorno: PAYMENT_REFUNDED / PAYMENT_PARTIALLY_REFUNDED mesmo
-- quando payment.status da Asaas permanece RECEIVED.
begin;

alter table public.payments
  add column if not exists gateway_environment text;

alter table public.payment_gateway_charges
  add column if not exists gateway_environment text;

alter table public.payments
  drop constraint if exists payments_gateway_environment_check;
alter table public.payments
  add constraint payments_gateway_environment_check
  check (gateway_environment is null or gateway_environment in ('sandbox', 'production'));

alter table public.payment_gateway_charges
  drop constraint if exists payment_gateway_charges_gateway_environment_check;
alter table public.payment_gateway_charges
  add constraint payment_gateway_charges_gateway_environment_check
  check (gateway_environment is null or gateway_environment in ('sandbox', 'production'));

comment on column public.payments.gateway_environment is
  'Ambiente da cobranca no gateway: sandbox | production. UI operacional mostra LIVE para production. Nao inferir por nome, e-mail, valor ou ticket.';

comment on column public.payment_gateway_charges.gateway_environment is
  'Ambiente da cobranca no gateway: sandbox | production.';

update public.payments
set gateway_environment = 'production'
where gateway_account_key = 'asaas-conta-live-01'
  and gateway_environment is null;

update public.payments
set gateway_environment = 'sandbox'
where gateway_account_key = 'asaas-sandbox-militrin'
  and gateway_environment is null;

update public.payments
set gateway_environment = 'sandbox'
where provider = 'asaas'
  and gateway_account_key is null
  and gateway_environment is null;

update public.payment_gateway_charges as charge
set gateway_environment = payment.gateway_environment
from public.payments as payment
where charge.payment_id = payment.id
  and charge.gateway_environment is null
  and payment.gateway_environment is not null;

update public.payment_gateway_charges
set gateway_environment = 'production'
where gateway_account_key = 'asaas-conta-live-01'
  and gateway_environment is null;

update public.payment_gateway_charges
set gateway_environment = 'sandbox'
where gateway_account_key = 'asaas-sandbox-militrin'
  and gateway_environment is null;

create or replace function public.fill_payment_gateway_environment()
returns trigger
language plpgsql
as $$
begin
  if new.gateway_environment in ('sandbox', 'production') then
    return new;
  end if;
  if new.gateway_account_key = 'asaas-conta-live-01' then
    new.gateway_environment := 'production';
  elsif new.gateway_account_key = 'asaas-sandbox-militrin' then
    new.gateway_environment := 'sandbox';
  elsif new.provider = 'asaas' and new.gateway_account_key is null then
    new.gateway_environment := 'sandbox';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_fill_payment_gateway_environment on public.payments;
create trigger trg_fill_payment_gateway_environment
before insert or update of gateway_account_key, gateway_environment, provider
on public.payments
for each row execute function public.fill_payment_gateway_environment();

create or replace function public.fill_charge_gateway_environment()
returns trigger
language plpgsql
as $$
begin
  if new.gateway_environment in ('sandbox', 'production') then
    return new;
  end if;
  if new.gateway_account_key = 'asaas-conta-live-01' then
    new.gateway_environment := 'production';
  elsif new.gateway_account_key = 'asaas-sandbox-militrin' then
    new.gateway_environment := 'sandbox';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_fill_charge_gateway_environment on public.payment_gateway_charges;
create trigger trg_fill_charge_gateway_environment
before insert or update of gateway_account_key, gateway_environment
on public.payment_gateway_charges
for each row execute function public.fill_charge_gateway_environment();

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

  -- Asaas pode enviar PAYMENT_PARTIALLY_REFUNDED / PAYMENT_REFUNDED com
  -- payment.status ainda RECEIVED. O tipo do evento e a fonte do estorno.
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

commit;
