-- Classe Laura / MIL-2026-00002299.
-- 1) Checkout adicional unassigned nao pode corromper participante ja emitido.
-- 2) Autoridade de expiracao: fluxo moderno (payments.order_id) = expire_stale
--    + prazo comercial PIX; release_expired_reservations so no legado sem order_id.
-- 3) expired→paid reconcilia automaticamente so quando as invariantes sao seguras.
-- Sem DML de dados. Nao repara Laura, Gian nem os 22 historicos.

begin;

-- ============================================================
-- Helpers
-- ============================================================

create or replace function public.participant_has_issued_event_ticket(p_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p_participant_id is not null and exists (
    select 1
    from public.tickets t
    left join public.order_items oi on oi.id = t.order_item_id
    where t.status in ('active', 'used')
      and (
        t.participant_id = p_participant_id
        or oi.participant_id = p_participant_id
      )
  ), false);
$$;

comment on function public.participant_has_issued_event_ticket(uuid) is
  'True se o participante ja possui ticket active/used neste evento (via tickets.participant_id ou order_items.participant_id).';

revoke all on function public.participant_has_issued_event_ticket(uuid) from public, anon, authenticated;

create or replace function public.apply_checkout_anchor_participant_update(
  p_participant_id uuid,
  p_buyer_full_name text,
  p_buyer_birth_date date,
  p_buyer_gender text,
  p_buyer_phone text,
  p_buyer_email text,
  p_buyer_city text,
  p_shirt_type text,
  p_shirt_size text,
  p_payment_status text,
  p_reservation_expires_at timestamptz,
  p_batch_id uuid,
  p_base_amount numeric,
  p_discount_amount numeric,
  p_final_amount numeric,
  p_ticket_category_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.participant_has_issued_event_ticket(p_participant_id) then
    update public.participants
    set
      full_name = trim(p_buyer_full_name),
      birth_date = p_buyer_birth_date,
      gender = trim(p_buyer_gender),
      phone = regexp_replace(coalesce(p_buyer_phone, ''), '\D', '', 'g'),
      email = lower(trim(p_buyer_email)),
      city = trim(p_buyer_city),
      updated_at = now()
    where id = p_participant_id;
    return;
  end if;

  update public.participants
  set
    full_name = trim(p_buyer_full_name),
    birth_date = p_buyer_birth_date,
    gender = trim(p_buyer_gender),
    phone = regexp_replace(coalesce(p_buyer_phone, ''), '\D', '', 'g'),
    email = lower(trim(p_buyer_email)),
    city = trim(p_buyer_city),
    shirt_type = coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), shirt_type),
    shirt_size = coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), shirt_size),
    registration_status = case when p_payment_status = 'paid' then 'confirmed' else 'pending' end,
    reservation_status = case when p_payment_status = 'paid' then 'confirmed' else 'pending' end,
    reservation_expires_at = p_reservation_expires_at,
    batch_id = p_batch_id,
    base_amount = coalesce(p_base_amount, 0),
    discount_amount = coalesce(p_discount_amount, 0),
    final_amount = coalesce(p_final_amount, 0),
    ticket_category_id = p_ticket_category_id,
    updated_at = now()
  where id = p_participant_id;
end;
$$;

revoke all on function public.apply_checkout_anchor_participant_update(
  uuid, text, date, text, text, text, text, text, text, text, timestamptz, uuid, numeric, numeric, numeric, uuid
) from public, anon, authenticated;

-- BEFORE UPDATE. So altera NEW; nao executa UPDATE na tabela, portanto nao
-- ha recursao. PII (nome/telefone/email/cidade/nascimento/genero) nao esta
-- na lista OF e passa intacta. Repair: SET LOCAL militrin.allow_issued_participant_repair='true'.
-- Ticket so cancelled/refunded nao e protegido (helper olha active/used).
create or replace function public.protect_issued_participant_from_checkout_overwrite()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('militrin.allow_issued_participant_repair', true) = 'true' then
    return new;
  end if;
  if not public.participant_has_issued_event_ticket(old.id) then
    return new;
  end if;

  new.shirt_type := old.shirt_type;
  new.shirt_size := old.shirt_size;
  new.registration_status := old.registration_status;
  new.reservation_status := old.reservation_status;
  new.reservation_expires_at := old.reservation_expires_at;
  new.reservation_released_at := old.reservation_released_at;
  new.batch_id := old.batch_id;
  new.base_amount := old.base_amount;
  new.discount_amount := old.discount_amount;
  new.final_amount := old.final_amount;
  new.ticket_category_id := old.ticket_category_id;
  new.notes := old.notes;
  return new;
end;
$$;

drop trigger if exists trg_protect_issued_participant_from_checkout_overwrite on public.participants;
create trigger trg_protect_issued_participant_from_checkout_overwrite
before update of
  shirt_type, shirt_size, registration_status, reservation_status,
  reservation_expires_at, reservation_released_at, batch_id,
  base_amount, discount_amount, final_amount, ticket_category_id, notes
on public.participants
for each row
execute function public.protect_issued_participant_from_checkout_overwrite();

create or replace function public.skip_orphan_kit_on_issued_participant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.ticket_id is null
     and new.order_item_id is null
     and new.participant_id is not null
     and public.participant_has_issued_event_ticket(new.participant_id) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_skip_orphan_kit_on_issued_participant on public.participant_kit_items;
create trigger trg_skip_orphan_kit_on_issued_participant
before insert on public.participant_kit_items
for each row
execute function public.skip_orphan_kit_on_issued_participant();

-- ============================================================
-- Relogios / expiracao
-- Prazo comercial intencional do fluxo moderno: pix_commercial_expires_at
-- (dueDate 23:59 America/Sao_Paulo). O +2h do checkout e hold de carrinho
-- ate o PIX existir; nao e o prazo de pagamento.
-- ============================================================

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
    if public.participant_has_issued_event_ticket(v_participant.id) then
      continue;
    end if;

    select * into v_payment
    from public.payments pay
    where pay.participant_id = v_participant.id
    order by pay.created_at desc
    limit 1
    for update;

    if not found then
      continue;
    end if;

    -- Fluxo moderno: expire_stale_order_payments e a unica autoridade.
    if v_payment.order_id is not null then
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
        event_id, inventory_id, movement_type, quantity, notes
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
      insert into public.audit_logs (action, entity_type, entity_id, details, event_id)
      values (
        'reservation_expired_released',
        'participants',
        v_participant.id,
        jsonb_build_object(
          'shirt_type', v_participant.shirt_type,
          'shirt_size', v_participant.shirt_size,
          'reservation_expires_at', v_participant.reservation_expires_at,
          'payment_id', v_payment.id,
          'legacy_only', true
        ),
        v_participant.event_id
      );
    end if;
  end loop;

  return v_released_count;
end;
$$;

create or replace function public._apply_terminal_order_payment_status(p_payment_id uuid, p_target_status text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_payment public.payments%rowtype;
  v_line record;
  v_remaining_paid integer;
begin
  if p_target_status not in ('expired','cancelled','refunded') then
    raise exception 'Status terminal invalido: %', p_target_status;
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then return; end if;

  update public.payments set
    payment_status = p_target_status,
    refunded_at = case when p_target_status = 'refunded' then coalesce(refunded_at, now()) else refunded_at end,
    refund_status = case when p_target_status = 'refunded' then 'completed' else refund_status end,
    expires_at = case when p_target_status in ('expired','cancelled') then null else expires_at end,
    updated_at = now()
  where id = p_payment_id;

  if v_payment.order_id is null then
    return;
  end if;

  if p_target_status = 'refunded' then
    select count(*)::integer into v_remaining_paid
    from public.payments
    where order_id = v_payment.order_id
      and id <> v_payment.id
      and payment_status = 'paid';

    if coalesce(v_remaining_paid, 0) = 0 then
      update public.orders set status = 'refunded' where id = v_payment.order_id;
    end if;
  else
    for v_line in
      update public.order_items set status = p_target_status, reservation_expires_at = null, updated_at = now()
      where order_id = v_payment.order_id and status = 'reserved'
      returning id, item_kind, store_item_id, store_item_variant_id, quantity
    loop
      if v_line.item_kind = 'product' then
        perform public.release_store_item_reservation(v_line.store_item_id, v_line.store_item_variant_id, v_line.quantity);
        update public.order_item_pickup_units set status = 'cancelled', updated_at = now()
        where order_item_id = v_line.id and status <> 'delivered';
      end if;
    end loop;

    update public.orders set status = p_target_status where id = v_payment.order_id and status = 'pending';

    if p_target_status = 'expired' then
      update public.participants pt
      set reservation_status = 'expired',
          registration_status = 'cancelled',
          reservation_released_at = now()
      where pt.reservation_status = 'pending'
        and not public.participant_has_issued_event_ticket(pt.id)
        and pt.id in (
          select oi.participant_id
          from public.order_items oi
          where oi.order_id = v_payment.order_id
            and oi.participant_id is not null
            and oi.status = 'expired'
        );
    end if;
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('payment_'||p_target_status, 'payments', p_payment_id, v_payment.event_id,
    jsonb_build_object('order_id', v_payment.order_id, 'provider', v_payment.provider, 'organization_id', v_payment.organization_id));
end;
$$;

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

  -- Alinha o relogio do participante-ancora pendente ao prazo comercial.
  -- Nunca toca participante que ja tem ticket active/used.
  update public.participants p
  set reservation_expires_at = p_expires_at,
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

-- ============================================================
-- expired → paid seguro
-- ============================================================

create or replace function public.try_issue_tickets_after_late_gateway_payment(
  p_payment_id uuid,
  p_previous_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_order public.orders%rowtype;
  v_item public.order_items%rowtype;
  v_event public.events%rowtype;
  v_reason text := null;
  v_needed integer := 0;
  v_available integer := 0;
  v_issued integer := 0;
  v_expected integer := 0;
  v_slots integer := null;
  v_additional integer := 0;
  v_held integer := 0;
  v_shirt text;
  v_size text;
begin
  if p_previous_status is distinct from 'expired' then
    return jsonb_build_object(
      'issued', false,
      'needs_manual_reconciliation', true,
      'reason', 'previous_status_not_expired',
      'previous_status', p_previous_status
    );
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    return jsonb_build_object('issued', false, 'needs_manual_reconciliation', true, 'reason', 'payment_not_found');
  end if;
  if v_payment.payment_status is distinct from 'paid' then
    return jsonb_build_object('issued', false, 'needs_manual_reconciliation', true, 'reason', 'payment_not_paid');
  end if;
  if v_payment.order_id is null then
    return jsonb_build_object('issued', false, 'needs_manual_reconciliation', true, 'reason', 'legacy_payment_without_order');
  end if;
  if coalesce(v_payment.refund_status, '') in ('completed', 'pending', 'processing')
     or v_payment.refunded_at is not null then
    return jsonb_build_object('issued', false, 'needs_manual_reconciliation', true, 'reason', 'incompatible_refund');
  end if;

  select * into v_order from public.orders where id = v_payment.order_id for update;
  if not found then
    return jsonb_build_object('issued', false, 'needs_manual_reconciliation', true, 'reason', 'order_not_found');
  end if;
  if v_order.status not in ('pending', 'expired', 'reserved') then
    return jsonb_build_object(
      'issued', false,
      'needs_manual_reconciliation', true,
      'reason', 'order_status_incompatible',
      'order_status', v_order.status
    );
  end if;

  select * into v_event from public.events where id = v_order.event_id for update;
  if not found then
    return jsonb_build_object('issued', false, 'needs_manual_reconciliation', true, 'reason', 'event_not_found');
  end if;

  for v_item in
    select *
    from public.order_items
    where order_id = v_order.id
    order by coalesce(item_position, 999999), created_at
    for update
  loop
    if coalesce(v_item.item_kind, 'ticket') <> 'ticket' then
      continue;
    end if;
    if exists (select 1 from public.tickets t where t.order_item_id = v_item.id) then
      continue;
    end if;
    if v_item.status in ('cancelled', 'refunded', 'transferred') then
      return jsonb_build_object(
        'issued', false,
        'needs_manual_reconciliation', true,
        'reason', 'item_not_materializable',
        'order_item_id', v_item.id,
        'item_status', v_item.status
      );
    end if;
    if v_item.status not in ('reserved', 'pending', 'expired', 'confirmed') then
      return jsonb_build_object(
        'issued', false,
        'needs_manual_reconciliation', true,
        'reason', 'item_not_materializable',
        'order_item_id', v_item.id,
        'item_status', v_item.status
      );
    end if;
    v_expected := v_expected + 1;
  end loop;

  if v_expected = 0 then
    update public.orders
    set status = 'confirmed',
        confirmed_at = coalesce(confirmed_at, now()),
        cancelled_at = null,
        payment_id = v_payment.id
    where id = v_order.id;
    return jsonb_build_object(
      'issued', true,
      'needs_manual_reconciliation', false,
      'reason', 'already_issued',
      'ticket_count', 0
    );
  end if;

  if coalesce(v_event.limit_shirt_selection_to_stock, false)
     and to_regprocedure('public.canonical_shirt_available_for_new_reservation(uuid, text, text, uuid)') is not null then
    for v_shirt, v_size, v_needed in
      select
        lower(trim(oi.shirt_type)),
        upper(trim(oi.shirt_size)),
        coalesce(sum(greatest(coalesce(oi.quantity, 1), 1)) filter (
          where not (
            (
              oi.status not in ('cancelled', 'expired', 'refunded', 'transferred')
              and not exists (
                select 1
                from public.tickets t
                join public.participant_kit_items pki on pki.ticket_id = t.id
                join public.event_kit_items eki on eki.id = pki.kit_item_id and eki.item_type = 'shirt'
                where t.order_item_id = oi.id
                  and pki.inventory_reservation_accounted
                  and pki.status not in ('cancelled')
              )
            )
            or exists (
              select 1
              from public.participant_kit_items pki
              join public.event_kit_items eki on eki.id = pki.kit_item_id and eki.item_type = 'shirt'
              where pki.order_item_id = oi.id
                and pki.inventory_reservation_accounted
                and pki.status not in ('cancelled')
            )
          )
        ), 0)::integer
      from public.order_items oi
      where oi.order_id = v_order.id
        and coalesce(oi.item_kind, 'ticket') = 'ticket'
        and not exists (select 1 from public.tickets t where t.order_item_id = oi.id)
        and nullif(trim(coalesce(oi.shirt_type, '')), '') is not null
        and nullif(trim(coalesce(oi.shirt_size, '')), '') is not null
        and lower(trim(oi.shirt_type)) not in ('sem camiseta', 'sem_camiseta')
      group by lower(trim(oi.shirt_type)), upper(trim(oi.shirt_size))
    loop
      if coalesce(v_needed, 0) <= 0 then
        continue;
      end if;
      v_available := public.canonical_shirt_available_for_new_reservation(
        v_order.event_id, v_shirt, v_size, null
      );
      if coalesce(v_available, 0) < v_needed then
        return jsonb_build_object(
          'issued', false,
          'needs_manual_reconciliation', true,
          'reason', 'insufficient_shirt_stock',
          'shirt_type', v_shirt,
          'shirt_size', v_size,
          'needed', v_needed,
          'available', v_available
        );
      end if;
    end loop;
  end if;

  for v_item in
    select *
    from public.order_items
    where order_id = v_order.id
      and coalesce(item_kind, 'ticket') = 'ticket'
      and not exists (select 1 from public.tickets t where t.order_item_id = order_items.id)
  loop
    select tc.available_slots into v_slots
    from public.get_event_ticket_categories(v_order.event_id) tc
    where tc.id = v_item.ticket_category_id;
    if v_slots is not null then
      select
        count(*) filter (where oi.status in ('reserved', 'pending', 'confirmed'))::integer,
        count(*) filter (where oi.status = 'expired')::integer
      into v_held, v_additional
      from public.order_items oi
      where oi.order_id = v_order.id
        and oi.ticket_category_id = v_item.ticket_category_id
        and coalesce(oi.item_kind, 'ticket') = 'ticket'
        and not exists (select 1 from public.tickets t where t.order_item_id = oi.id);
      if v_slots < coalesce(v_additional, 0) then
        return jsonb_build_object(
          'issued', false,
          'needs_manual_reconciliation', true,
          'reason', 'insufficient_category_capacity',
          'ticket_category_id', v_item.ticket_category_id,
          'available_slots', v_slots,
          'needed', v_additional
        );
      end if;
    end if;
    exit;
  end loop;

  begin
    update public.order_items
    set status = 'reserved',
        updated_at = now()
    where order_id = v_order.id
      and status = 'expired'
      and coalesce(item_kind, 'ticket') = 'ticket';

    update public.orders
    set status = 'pending',
        cancelled_at = null
    where id = v_order.id
      and status = 'expired';

    perform public.confirm_order_payment_and_issue_tickets(v_order.id);

    select count(*)::integer into v_issued
    from public.tickets t
    join public.order_items oi on oi.id = t.order_item_id
    where oi.order_id = v_order.id
      and t.status in ('active', 'used');

    if v_issued < v_expected then
      raise exception 'LATE_PAY_ISSUE_INCOMPLETE';
    end if;

    return jsonb_build_object(
      'issued', true,
      'needs_manual_reconciliation', false,
      'reason', 'reconciled',
      'ticket_count', v_issued
    );
  exception when others then
    v_reason := sqlerrm;
    return jsonb_build_object(
      'issued', false,
      'needs_manual_reconciliation', true,
      'reason', 'issue_failed',
      'error', v_reason
    );
  end;
end;
$$;

revoke all on function public.try_issue_tickets_after_late_gateway_payment(uuid, text)
from public, anon, authenticated;

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
  v_late jsonb;
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
      v_late := public.try_issue_tickets_after_late_gateway_payment(v_payment.id, v_previous);
      insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
      values('payment_paid_after_'||v_previous,'payments',v_payment.id,v_payment.event_id,
        jsonb_build_object(
          'provider', p_provider,
          'provider_payment_id', p_provider_payment_id,
          'order_id', v_payment.order_id,
          'previous_status', v_previous,
          'needs_manual_reconciliation', coalesce((v_late->>'needs_manual_reconciliation')::boolean, true),
          'late_issue', v_late
        ));
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

-- Writer de origem: nao sobrescreve campos protegidos se ja existe ticket active/used.
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

    v_available_stock := coalesce(v_inventory.total_quantity, 0) - coalesce(v_inventory.reserved_quantity, 0) - coalesce(v_inventory.delivered_quantity, 0);
    if v_available_stock < p_quantity then
      raise exception 'Estoque insuficiente para a quantidade solicitada (%).', p_quantity;
    end if;
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
    v_reservation_expires_at := now() + interval '2 hours';
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

commit;
