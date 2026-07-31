-- 039_allow_repeat_purchases_same_cpf.sql
-- Permite compras repetidas pelo mesmo CPF no mesmo evento,
-- reutiliza participante existente e remove a unicidade de orders.participant_id.

-- 1) Orders: remove unicidade por participante (1:N participante -> pedidos)
drop index if exists public.ux_orders_participant_id;
drop index if exists ux_orders_participant_id;

alter table if exists public.orders
  drop constraint if exists orders_participant_id_key;

create index if not exists idx_orders_participant_id
  on public.orders (participant_id);

-- 2) create_registration: parar de bloquear CPF repetido no mesmo evento
-- e reutilizar o participante existente.
do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
  v_dup_check_old text;
  v_dup_check_new text;
  v_insert_old text;
  v_insert_new text;
begin
  v_fn_oid := to_regprocedure('public.create_registration(text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid)');

  if v_fn_oid is null then
    raise exception 'Funcao public.create_registration(text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text, uuid) nao encontrada.';
  end if;

  select pg_get_functiondef(v_fn_oid)
  into v_def_original;

  v_def_new := v_def_original;

  v_dup_check_old := $old$
  if exists (
    select 1
    from public.participants
    where cpf = p_cpf and event_id = v_event_id
  ) then
    raise exception 'CPF ja cadastrado para o evento ativo.';
  end if;
$old$;

  v_dup_check_new := $new$
  select p.id
    into v_participant_id
  from public.participants p
  where p.cpf = p_cpf
    and p.event_id = v_event_id
  order by p.created_at asc
  limit 1
  for update;
$new$;

  v_def_new := replace(v_def_new, v_dup_check_old, v_dup_check_new);

  v_insert_old := $old$
  insert into public.participants (
    event_id,
    full_name,
    cpf,
    birth_date,
    gender,
    phone,
    email,
    city,
    shirt_type,
    shirt_size,
    registration_status,
    notes,
    reservation_status,
    reservation_expires_at,
    reservation_released_at,
    batch_id,
    base_amount,
    discount_amount,
    final_amount,
    ticket_category_id
  ) values (
    v_event_id,
    p_full_name,
    p_cpf,
    p_birth_date,
    p_gender,
    p_phone,
    p_email,
    p_city,
    v_shirt_type,
    v_shirt_size,
    coalesce(p_registration_status, case when v_payment_status = 'paid' then 'confirmed' else 'pending' end),
    p_notes,
    v_reservation_status,
    v_reservation_expires_at,
    null,
    v_batch.id,
    v_base_amount,
    v_discount_amount,
    v_final_amount,
    v_ticket_category_id
  ) returning id into v_participant_id;
$old$;

  v_insert_new := $new$
  if v_participant_id is null then
    insert into public.participants (
      event_id,
      full_name,
      cpf,
      birth_date,
      gender,
      phone,
      email,
      city,
      shirt_type,
      shirt_size,
      registration_status,
      notes,
      reservation_status,
      reservation_expires_at,
      reservation_released_at,
      batch_id,
      base_amount,
      discount_amount,
      final_amount,
      ticket_category_id
    ) values (
      v_event_id,
      p_full_name,
      p_cpf,
      p_birth_date,
      p_gender,
      p_phone,
      p_email,
      p_city,
      v_shirt_type,
      v_shirt_size,
      coalesce(p_registration_status, case when v_payment_status = 'paid' then 'confirmed' else 'pending' end),
      p_notes,
      v_reservation_status,
      v_reservation_expires_at,
      null,
      v_batch.id,
      v_base_amount,
      v_discount_amount,
      v_final_amount,
      v_ticket_category_id
    ) returning id into v_participant_id;
  else
    update public.participants
    set
      full_name = p_full_name,
      cpf = p_cpf,
      birth_date = p_birth_date,
      gender = p_gender,
      phone = p_phone,
      email = p_email,
      city = p_city,
      shirt_type = v_shirt_type,
      shirt_size = v_shirt_size,
      registration_status = coalesce(p_registration_status, case when v_payment_status = 'paid' then 'confirmed' else 'pending' end),
      notes = p_notes,
      reservation_status = v_reservation_status,
      reservation_expires_at = v_reservation_expires_at,
      reservation_released_at = null,
      batch_id = v_batch.id,
      base_amount = v_base_amount,
      discount_amount = v_discount_amount,
      final_amount = v_final_amount,
      ticket_category_id = v_ticket_category_id,
      updated_at = now()
    where id = v_participant_id;
  end if;
$new$;

  v_def_new := replace(v_def_new, v_insert_old, v_insert_new);

  if v_def_new <> v_def_original then
    execute v_def_new;
  end if;
end
$$;

-- 3) Legacy checkout: voltar a criar novo pedido por compra
-- (a deduplicacao por client_request_id continua ativa no inicio da funcao).
do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
  v_order_reuse_block text;
  v_order_insert_block text;
begin
  v_fn_oid := to_regprocedure('public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)');

  if v_fn_oid is null then
    raise exception 'Funcao public.create_multi_ticket_order_checkout_legacy nao encontrada.';
  end if;

  select pg_get_functiondef(v_fn_oid)
  into v_def_original;

  v_def_new := v_def_original;

  v_order_reuse_block := $old$
  select o.id, o.order_number
    into v_order_id, v_order_number
  from public.orders o
  where o.participant_id = v_anchor_participant_id
  limit 1
  for update;

  if v_order_id is null then
    v_order_number := public.generate_order_number();

    insert into public.orders (
      user_id,
      participant_id,
      event_id,
      payment_id,
      order_number,
      status,
      base_amount,
      discount_amount,
      final_amount,
      confirmed_at,
      cancelled_at,
      client_request_id
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
    )
    returning id into v_order_id;
  else
    update public.orders o
    set
      user_id = v_user_id,
      event_id = p_event_id,
      status = case
        when v_payment_status = 'paid' then 'confirmed'
        else 'pending'
      end,
      base_amount = v_total_amount,
      discount_amount = v_total_discount,
      final_amount = v_total_final,
      confirmed_at = case
        when v_payment_status = 'paid'
          then coalesce(o.confirmed_at, now())
        else o.confirmed_at
      end,
      cancelled_at = null,
      client_request_id = coalesce(
        nullif(trim(coalesce(p_client_request_id, '')), ''),
        o.client_request_id
      ),
      updated_at = now()
    where o.id = v_order_id;
  end if;
$old$;

  v_order_insert_block := $new$
  v_order_number := public.generate_order_number();

  insert into public.orders (
    user_id,
    participant_id,
    event_id,
    payment_id,
    order_number,
    status,
    base_amount,
    discount_amount,
    final_amount,
    confirmed_at,
    cancelled_at,
    client_request_id
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
$new$;

  v_def_new := replace(v_def_new, v_order_reuse_block, v_order_insert_block);

  if v_def_new <> v_def_original then
    execute v_def_new;
  end if;
end
$$;

-- 4) ensure_order_for_participant: nao reaproveitar pedido por participante;
-- reaproveitar apenas se o pedido ja estiver ligado ao mesmo pagamento.
do $$
declare
  v_fn_oid oid;
  v_def_original text;
  v_def_new text;
  v_lookup_old text;
  v_lookup_new text;
begin
  v_fn_oid := to_regprocedure('public.ensure_order_for_participant(uuid, uuid)');

  if v_fn_oid is null then
    raise exception 'Funcao public.ensure_order_for_participant(uuid, uuid) nao encontrada.';
  end if;

  select pg_get_functiondef(v_fn_oid)
  into v_def_original;

  v_def_new := v_def_original;

  v_lookup_old := $old$
  select o.id into v_order_id
  from public.orders o
  where o.participant_id = p_participant_id
  limit 1;
$old$;

  v_lookup_new := $new$
  select o.id into v_order_id
  from public.orders o
  where o.payment_id = v_payment.id
  limit 1
  for update;
$new$;

  v_def_new := replace(v_def_new, v_lookup_old, v_lookup_new);

  if v_def_new <> v_def_original then
    execute v_def_new;
  end if;
end
$$;
