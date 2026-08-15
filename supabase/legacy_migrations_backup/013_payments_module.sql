-- 013_payments_module.sql
-- Modulo financeiro: estrutura de pagamentos, PIX/cartao simulado e expiracao automatica.

alter table public.payments
  add column if not exists discount_amount numeric(10,2) not null default 0,
  add column if not exists final_amount numeric(10,2) not null default 0,
  add column if not exists pix_code text,
  add column if not exists pix_qrcode text,
  add column if not exists gateway_payment_id text,
  add column if not exists expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update public.payments
set
  final_amount = coalesce(final_amount, amount, 0),
  discount_amount = coalesce(discount_amount, 0),
  updated_at = now()
where final_amount is null
   or discount_amount is null;

alter table public.payments
  drop constraint if exists payments_method_check;

alter table public.payments
  add constraint payments_method_check
  check (coalesce(payment_method, 'pix') in ('pix', 'credit_card', 'cash', 'courtesy'));

alter table public.payments
  drop constraint if exists payments_status_check;

alter table public.payments
  add constraint payments_status_check
  check (payment_status in ('pending', 'paid', 'expired', 'cancelled', 'refunded'));

create index if not exists idx_payments_event_status on public.payments (event_id, payment_status);
create index if not exists idx_payments_method_status on public.payments (payment_method, payment_status);
create index if not exists idx_payments_expires_at on public.payments (expires_at);

create or replace function public.touch_payments_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_payments_updated_at on public.payments;
create trigger trg_touch_payments_updated_at
before update on public.payments
for each row
execute function public.touch_payments_updated_at();

create or replace function public.start_payment_pix(
  p_participant_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz
)
returns table (
  payment_id uuid,
  participant_id uuid,
  event_id uuid,
  amount numeric,
  discount_amount numeric,
  final_amount numeric,
  payment_method text,
  payment_status text,
  pix_code text,
  pix_qrcode text,
  gateway_payment_id text,
  expires_at timestamptz,
  paid_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
begin
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
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
      v_payment.id,
      v_payment.participant_id,
      v_payment.event_id,
      v_payment.amount,
      coalesce(v_payment.discount_amount, 0),
      coalesce(v_payment.final_amount, v_payment.amount),
      v_payment.payment_method,
      v_payment.payment_status,
      v_payment.pix_code,
      v_payment.pix_qrcode,
      v_payment.gateway_payment_id,
      v_payment.expires_at,
      v_payment.paid_at;
    return;
  end if;

  update public.payments
  set payment_method = 'pix',
      payment_status = 'pending',
      pix_code = p_pix_code,
      pix_qrcode = p_pix_qrcode,
      gateway_payment_id = p_gateway_payment_id,
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
      'gateway_payment_id', p_gateway_payment_id
    ),
    v_participant.event_id
  );

  return query
  select
    v_payment.id,
    v_payment.participant_id,
    v_payment.event_id,
    v_payment.amount,
    coalesce(v_payment.discount_amount, 0),
    coalesce(v_payment.final_amount, v_payment.amount),
    v_payment.payment_method,
    v_payment.payment_status,
    v_payment.pix_code,
    v_payment.pix_qrcode,
    v_payment.gateway_payment_id,
    v_payment.expires_at,
    v_payment.paid_at;
end;
$$;

create or replace function public.simulate_payment_paid(
  p_participant_id uuid,
  p_payment_method text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_method text := lower(trim(coalesce(p_payment_method, 'pix')));
begin
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
  end if;

  if v_method not in ('pix', 'credit_card', 'cash', 'courtesy') then
    raise exception 'Metodo de pagamento invalido.';
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
    raise exception 'Pagamento ja confirmado.';
  end if;

  if v_payment.payment_status in ('expired', 'cancelled', 'refunded') then
    raise exception 'Pagamento nao pode ser confirmado neste status.';
  end if;

  update public.payments
  set payment_method = v_method,
      payment_status = 'paid',
      paid_at = now(),
      expires_at = null
  where id = v_payment.id;

  perform public.confirm_registration_payment(p_participant_id);

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'payment_simulated_paid',
    'payments',
    v_payment.id,
    jsonb_build_object(
      'participant_id', p_participant_id,
      'payment_method', v_method
    ),
    v_participant.event_id
  );

  return true;
end;
$$;

create or replace function public.cancel_registration_payment(
  p_participant_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_payment public.payments%rowtype;
  v_inventory public.shirt_inventory%rowtype;
begin
  if p_participant_id is null then
    raise exception 'Participante obrigatorio.';
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
    raise exception 'Pagamento pago nao pode ser cancelado por esta rotina.';
  end if;

  update public.payments
  set payment_status = 'cancelled',
      expires_at = null
  where id = v_payment.id;

  if v_participant.reservation_status = 'pending' then
    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if found and v_inventory.reserved_quantity > 0 then
      update public.shirt_inventory
      set reserved_quantity = reserved_quantity - 1,
          updated_at = now()
      where id = v_inventory.id
        and reserved_quantity > 0;

      insert into public.inventory_movements (
        event_id,
        inventory_id,
        movement_type,
        quantity,
        notes
      ) values (
        v_participant.event_id,
        v_inventory.id,
        'adjustment',
        1,
        format('Cancelamento de pagamento para participante %s.', v_participant.full_name)
      );
    end if;
  end if;

  update public.participants
  set registration_status = 'cancelled',
      reservation_status = 'released',
      reservation_released_at = now(),
      reservation_expires_at = null,
      updated_at = now()
  where id = p_participant_id;

  insert into public.audit_logs (
    action,
    entity_type,
    entity_id,
    details,
    event_id
  ) values (
    'payment_cancelled',
    'participants',
    p_participant_id,
    jsonb_build_object(
      'reason', nullif(trim(coalesce(p_reason, '')), ''),
      'payment_id', v_payment.id
    ),
    v_participant.event_id
  );

  return true;
end;
$$;

create or replace function public.release_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_inventory public.shirt_inventory%rowtype;
  v_payment public.payments%rowtype;
  v_released_count integer := 0;
begin
  for v_participant in
    select *
    from public.participants
    where reservation_status = 'pending'
      and reservation_expires_at is not null
      and reservation_expires_at <= now()
    for update skip locked
  loop
    select * into v_payment
    from public.payments pay
    where pay.participant_id = v_participant.id
    order by pay.created_at desc
    limit 1
    for update;

    if not found then
      continue;
    end if;

    if v_payment.payment_status <> 'pending' then
      continue;
    end if;

    select * into v_inventory
    from public.shirt_inventory
    where event_id = v_participant.event_id
      and shirt_type = v_participant.shirt_type
      and shirt_size = v_participant.shirt_size
    for update;

    if found and v_inventory.reserved_quantity > 0 then
      update public.shirt_inventory
      set reserved_quantity = reserved_quantity - 1,
          updated_at = now()
      where id = v_inventory.id
        and reserved_quantity > 0;

      insert into public.inventory_movements (
        event_id,
        inventory_id,
        movement_type,
        quantity,
        notes
      ) values (
        v_participant.event_id,
        v_inventory.id,
        'adjustment',
        1,
        format('Reserva expirada para participante %s.', v_participant.full_name)
      );
    end if;

    update public.payments
    set payment_status = 'expired',
        expires_at = null
    where id = v_payment.id;

    update public.participants
    set registration_status = 'cancelled',
        reservation_status = 'expired',
        reservation_released_at = now(),
        reservation_expires_at = null,
        updated_at = now()
    where id = v_participant.id
      and reservation_status = 'pending';

    if found then
      v_released_count := v_released_count + 1;

      insert into public.audit_logs (
        action,
        entity_type,
        entity_id,
        details,
        event_id
      ) values (
        'reservation_expired_released',
        'participants',
        v_participant.id,
        jsonb_build_object(
          'shirt_type', v_participant.shirt_type,
          'shirt_size', v_participant.shirt_size,
          'reservation_expires_at', v_participant.reservation_expires_at,
          'payment_id', v_payment.id
        ),
        v_participant.event_id
      );
    end if;
  end loop;

  return v_released_count;
end;
$$;

create or replace function public.get_participant_payment_details(
  p_participant_id uuid
)
returns table (
  payment_id uuid,
  participant_id uuid,
  event_id uuid,
  event_name text,
  amount numeric,
  discount_amount numeric,
  final_amount numeric,
  payment_method text,
  payment_status text,
  pix_code text,
  pix_qrcode text,
  gateway_payment_id text,
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select
    pay.id,
    pay.participant_id,
    pay.event_id,
    e.name,
    pay.amount,
    coalesce(pay.discount_amount, 0),
    coalesce(pay.final_amount, pay.amount),
    pay.payment_method,
    pay.payment_status,
    pay.pix_code,
    pay.pix_qrcode,
    pay.gateway_payment_id,
    pay.expires_at,
    pay.paid_at,
    pay.created_at,
    pay.updated_at
  from public.payments pay
  left join public.events e
    on e.id = pay.event_id
  where pay.participant_id = p_participant_id
  order by pay.created_at desc
  limit 1;
end;
$$;

revoke all on function public.start_payment_pix(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.simulate_payment_paid(uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_registration_payment(uuid, text) from public, anon, authenticated;
revoke all on function public.get_participant_payment_details(uuid) from public, anon, authenticated;

grant execute on function public.start_payment_pix(uuid, text, text, text, timestamptz) to anon, authenticated;
grant execute on function public.simulate_payment_paid(uuid, text) to anon, authenticated;
grant execute on function public.cancel_registration_payment(uuid, text) to anon, authenticated;
grant execute on function public.get_participant_payment_details(uuid) to anon, authenticated;
