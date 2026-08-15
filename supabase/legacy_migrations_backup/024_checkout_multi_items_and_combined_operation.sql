-- 023_checkout_multi_items_and_combined_operation.sql
-- Checkout multi-ingressos com itens nao nominais + operacao combinada de kit e check-in.

alter table if exists public.events
  add column if not exists allow_checkin_during_kit_delivery boolean not null default false;

alter table if exists public.orders
  add column if not exists client_request_id text;

create unique index if not exists ux_orders_user_client_request
  on public.orders (user_id, client_request_id)
  where client_request_id is not null;

alter table if exists public.order_items
  add column if not exists ownership_status text,
  add column if not exists pricing_gender text,
  add column if not exists item_position integer,
  add column if not exists holder_full_name text,
  add column if not exists holder_email text,
  add column if not exists holder_phone text;

update public.order_items
set ownership_status = 'unassigned'
where ownership_status is null;

update public.order_items
set pricing_gender = 'male'
where pricing_gender is null;

alter table if exists public.order_items
  alter column pricing_gender set default 'male',
  alter column pricing_gender set not null,
  alter column ownership_status set default 'unassigned',
  alter column ownership_status set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.conname = 'chk_order_items_ownership_status'
      and n.nspname = 'public'
      and t.relname = 'order_items'
  ) then
    alter table public.order_items
      add constraint chk_order_items_ownership_status
      check (ownership_status in ('unassigned', 'assigned', 'transferred', 'cancelled'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where c.conname = 'chk_order_items_pricing_gender'
      and n.nspname = 'public'
      and t.relname = 'order_items'
  ) then
    alter table public.order_items
      add constraint chk_order_items_pricing_gender
      check (pricing_gender in ('male', 'female'));
  end if;
end
$$;

create unique index if not exists ux_order_items_order_item_position
  on public.order_items (order_id, item_position)
  where item_position is not null;

create index if not exists idx_order_items_order_status
  on public.order_items (order_id, status);

do $$
begin
  if to_regprocedure('public.current_user_has_permission(text)') is null then
    execute $fn$
      create function public.current_user_has_permission(
        p_permission_code text
      )
      returns boolean
      language plpgsql
      security definer
      set search_path = public, pg_temp
      as $body$
      declare
        v_actor_user_id uuid := auth.uid();
        v_permission_id uuid;
        v_has_deny boolean := false;
        v_has_allow boolean := false;
        v_has_role_permission boolean := false;
      begin
        if v_actor_user_id is null then
          return false;
        end if;

        if p_permission_code is null or btrim(p_permission_code) = '' then
          return false;
        end if;

        if to_regclass('public.admin_permissions') is null
          or to_regclass('public.admin_users') is null
          or to_regclass('public.admin_roles') is null
          or to_regclass('public.admin_role_permissions') is null
          or to_regclass('public.admin_user_permission_overrides') is null then
          return false;
        end if;

        select ap.id
          into v_permission_id
        from public.admin_permissions ap
        where ap.code = p_permission_code
          and ap.is_active = true
        limit 1;

        if v_permission_id is null then
          return false;
        end if;

        select exists (
          select 1
          from public.admin_user_permission_overrides uo
          where uo.user_id = v_actor_user_id
            and uo.permission_id = v_permission_id
            and uo.effect = 'deny'
        ) into v_has_deny;

        if v_has_deny then
          return false;
        end if;

        select exists (
          select 1
          from public.admin_user_permission_overrides uo
          where uo.user_id = v_actor_user_id
            and uo.permission_id = v_permission_id
            and uo.effect = 'allow'
        ) into v_has_allow;

        if v_has_allow then
          return true;
        end if;

        select exists (
          select 1
          from public.admin_users au
          join public.admin_roles ar
            on ar.id = au.role_id
           and ar.is_active = true
          join public.admin_role_permissions arp
            on arp.role_id = ar.id
          where au.user_id = v_actor_user_id
            and au.is_active = true
            and arp.permission_id = v_permission_id
        ) into v_has_role_permission;

        return v_has_role_permission;
      end;
      $body$;
    $fn$;

    execute 'revoke all on function public.current_user_has_permission(text) from public, anon';
    execute 'grant execute on function public.current_user_has_permission(text) to authenticated';
  end if;
end
$$;

create or replace function public.start_order_payment_pix(
  p_order_id uuid,
  p_pix_code text,
  p_pix_qrcode text,
  p_gateway_payment_id text,
  p_expires_at timestamptz
)
returns table (
  payment_id uuid,
  order_id uuid,
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
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
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
  where order_id = p_order_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Pagamento nao encontrado para o pedido.';
  end if;

  if v_payment.payment_status = 'paid' then
    return query
    select
      v_payment.id,
      p_order_id,
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
      paid_at = null,
      updated_at = now()
  where id = v_payment.id
  returning * into v_payment;

  update public.order_items
  set status = 'reserved',
      reservation_expires_at = p_expires_at,
      updated_at = now()
  where order_id = p_order_id
    and status not in ('cancelled', 'expired', 'refunded', 'transferred');

  update public.orders
  set status = 'pending',
      cancelled_at = null
  where id = p_order_id;

  return query
  select
    v_payment.id,
    p_order_id,
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

create or replace function public.confirm_order_payment_and_issue_tickets(
  p_order_id uuid
)
returns table (
  order_id uuid,
  order_number text,
  payment_id uuid,
  payment_status text,
  issued_tickets integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_item record;
  v_ticket_id uuid;
  v_count integer := 0;
begin
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado.';
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

  if v_payment.payment_status <> 'paid' then
    raise exception 'Pagamento ainda nao confirmado.';
  end if;

  update public.orders
  set status = 'confirmed',
      confirmed_at = coalesce(confirmed_at, now()),
      cancelled_at = null,
      payment_id = v_payment.id
  where id = p_order_id;

  for v_item in
    select oi.id
    from public.order_items oi
    where oi.order_id = p_order_id
      and oi.status not in ('cancelled', 'expired', 'refunded', 'transferred')
    order by coalesce(oi.item_position, 999999), oi.created_at
  loop
    select public.confirm_order_item_and_issue_ticket(v_item.id) into v_ticket_id;
    if v_ticket_id is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  return query
  select
    v_order.id,
    v_order.order_number,
    v_payment.id,
    v_payment.payment_status,
    v_count;
end;
$$;

create or replace function public.simulate_order_payment_paid(
  p_order_id uuid,
  p_payment_method text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_method text := lower(trim(coalesce(p_payment_method, 'pix')));
begin
  if p_order_id is null then
    raise exception 'Pedido obrigatorio.';
  end if;

  if v_method not in ('pix', 'credit_card', 'cash', 'courtesy') then
    raise exception 'Metodo de pagamento invalido.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'Pedido nao encontrado.';
  end if;

  if auth.uid() is not null and auth.uid() <> v_order.user_id then
    raise exception 'Sem permissao para confirmar este pedido.';
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
    perform public.confirm_order_payment_and_issue_tickets(p_order_id);
    return true;
  end if;

  if v_payment.payment_status in ('expired', 'cancelled', 'refunded') then
    raise exception 'Pagamento nao pode ser confirmado neste status.';
  end if;

  update public.payments
  set payment_method = v_method,
      payment_status = 'paid',
      paid_at = now(),
      expires_at = null,
      updated_at = now()
  where id = v_payment.id;

  perform public.confirm_order_payment_and_issue_tickets(p_order_id);

  return true;
end;
$$;

create or replace function public.create_multi_ticket_order_checkout(
  p_event_id uuid,
  p_ticket_category_id uuid,
  p_gender text,
  p_quantity integer,
  p_payment_method text,
  p_coupon_code text default null,
  p_shirt_type text default null,
  p_shirt_size text default null,
  p_buyer_full_name text default null,
  p_buyer_cpf text default null,
  p_buyer_birth_date date default null,
  p_buyer_gender text default null,
  p_buyer_phone text default null,
  p_buyer_email text default null,
  p_buyer_city text default null,
  p_assign_first_to_buyer boolean default true,
  p_items jsonb default '[]'::jsonb,
  p_limit_per_order integer default 10,
  p_notes text default null,
  p_client_request_id text default null
)
returns table (
  order_id uuid,
  payment_id uuid,
  order_number text,
  payment_status text,
  reservation_expires_at timestamptz,
  item_count integer,
  amount numeric,
  discount_amount numeric,
  final_amount numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_event public.events%rowtype;
  v_pricing record;
  v_batch_id uuid;
  v_order_id uuid;
  v_order_number text;
  v_payment_id uuid;
  v_anchor_participant_id uuid;
  v_reservation_expires_at timestamptz;
  v_item_index integer;
  v_item_payload jsonb;
  v_ownership_status text;
  v_holder_name text;
  v_holder_email text;
  v_holder_phone text;
  v_default_pricing_gender text;
  v_item_pricing_gender text;
  v_item_shirt_type text;
  v_item_shirt_size text;
  v_item_base_amount numeric;
  v_item_discount_amount numeric;
  v_item_final_amount numeric;
  v_status text := 'reserved';
  v_payment_status text := 'pending';
  v_total_amount numeric := 0;
  v_total_discount numeric := 0;
  v_total_final numeric := 0;
  v_available_category integer;
  v_unassigned_in_category integer := 0;
  v_required_shirt boolean := false;
  v_inventory public.shirt_inventory%rowtype;
  v_existing_order public.orders%rowtype;
  v_stock_req record;
  v_stock_available integer;
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

  v_default_pricing_gender := lower(trim(coalesce(p_gender, p_buyer_gender, '')));

  if v_default_pricing_gender in ('masculino', 'm') then
    v_default_pricing_gender := 'male';
  elsif v_default_pricing_gender in ('feminino', 'f') then
    v_default_pricing_gender := 'female';
  end if;

  if v_default_pricing_gender not in ('male', 'female') then
    raise exception 'Genero invalido para calculo de preco. Use Masculino ou Feminino.';
  end if;

  select * into v_pricing
  from public.get_registration_pricing_preview(
    v_default_pricing_gender,
    nullif(trim(coalesce(p_coupon_code, '')), ''),
    p_event_id,
    p_ticket_category_id
  )
  limit 1;

  if v_pricing.batch_id is null then
    raise exception 'Nao foi possivel calcular o preco para a categoria.';
  end if;

  v_batch_id := v_pricing.batch_id;

  select tc.available_slots
  into v_available_category
  from public.get_event_ticket_categories(p_event_id) tc
  where tc.id = p_ticket_category_id
  limit 1;

  if v_available_category is null then
    v_available_category := 2147483647;
  end if;

  select count(*)::integer into v_unassigned_in_category
  from public.order_items oi
  where oi.event_id = p_event_id
    and oi.ticket_category_id = p_ticket_category_id
    and oi.participant_id is null
    and oi.status in ('reserved', 'confirmed');

  if (v_available_category - v_unassigned_in_category) < p_quantity then
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

  v_total_amount := 0;
  v_total_discount := 0;
  v_total_final := 0;

  if lower(trim(coalesce(p_payment_method, ''))) = 'courtesy' then
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
    and (p.user_id = v_user_id or p.user_id is null)
  order by case when p.user_id = v_user_id then 0 else 1 end, p.created_at asc
  limit 1
  for update;

  if v_anchor_participant_id is null then
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
      batch_id,
      base_amount,
      discount_amount,
      final_amount,
      ticket_category_id,
      user_id
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
      0,
      0,
      0,
      p_ticket_category_id,
      v_user_id
    ) returning id into v_anchor_participant_id;
  else
    update public.participants
    set
      user_id = coalesce(user_id, v_user_id),
      full_name = trim(p_buyer_full_name),
      birth_date = p_buyer_birth_date,
      gender = trim(p_buyer_gender),
      phone = regexp_replace(coalesce(p_buyer_phone, ''), '\\D', '', 'g'),
      email = lower(trim(p_buyer_email)),
      city = trim(p_buyer_city),
      shirt_type = coalesce(nullif(trim(coalesce(p_shirt_type, '')), ''), shirt_type),
      shirt_size = coalesce(nullif(trim(coalesce(p_shirt_size, '')), ''), shirt_size),
      registration_status = case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      reservation_status = case when v_payment_status = 'paid' then 'confirmed' else 'pending' end,
      reservation_expires_at = v_reservation_expires_at,
      batch_id = v_batch_id,
      base_amount = 0,
      discount_amount = 0,
      final_amount = 0,
      ticket_category_id = p_ticket_category_id,
      updated_at = now()
    where id = v_anchor_participant_id;
  end if;

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

  insert into public.payments (
    participant_id,
    event_id,
    amount,
    discount_amount,
    final_amount,
    payment_method,
    payment_status,
    paid_at,
    expires_at,
    order_id
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

    v_ownership_status := lower(trim(coalesce(v_item_payload ->> 'ownership_status', case when p_assign_first_to_buyer and v_item_index = 1 then 'assigned' else 'unassigned' end)));
    v_holder_name := nullif(trim(coalesce(v_item_payload ->> 'holder_full_name', '')), '');
    v_holder_email := nullif(lower(trim(coalesce(v_item_payload ->> 'holder_email', ''))), '');
    v_holder_phone := nullif(regexp_replace(coalesce(v_item_payload ->> 'holder_phone', ''), '\\D', '', 'g'), '');
    v_item_pricing_gender := lower(trim(coalesce(v_item_payload ->> 'pricing_gender', v_item_payload ->> 'price_gender', p_gender, p_buyer_gender, '')));
    v_item_shirt_type := nullif(trim(coalesce(v_item_payload ->> 'shirt_type', p_shirt_type, '')), '');
    v_item_shirt_size := nullif(trim(coalesce(v_item_payload ->> 'shirt_size', p_shirt_size, '')), '');

    if v_ownership_status not in ('unassigned', 'assigned', 'transferred', 'cancelled') then
      v_ownership_status := 'unassigned';
    end if;

    if v_item_pricing_gender in ('masculino', 'm') then
      v_item_pricing_gender := 'male';
    elsif v_item_pricing_gender in ('feminino', 'f') then
      v_item_pricing_gender := 'female';
    end if;

    if v_item_pricing_gender not in ('male', 'female') then
      raise exception 'Genero invalido no ingresso %.', v_item_index;
    end if;

    select * into v_pricing
    from public.get_registration_pricing_preview(
      v_item_pricing_gender,
      nullif(trim(coalesce(p_coupon_code, '')), ''),
      p_event_id,
      p_ticket_category_id
    )
    limit 1;

    if v_pricing.batch_id is null then
      raise exception 'Nao foi possivel calcular preco do ingresso %.', v_item_index;
    end if;

    if v_batch_id is null then
      v_batch_id := v_pricing.batch_id;
    end if;

    v_item_base_amount := round(coalesce(v_pricing.base_amount, 0), 2);
    v_item_discount_amount := round(coalesce(v_pricing.discount_amount, 0), 2);
    v_item_final_amount := round(coalesce(v_pricing.final_amount, 0), 2);

    v_total_amount := round(v_total_amount + v_item_base_amount, 2);
    v_total_discount := round(v_total_discount + v_item_discount_amount, 2);
    v_total_final := round(v_total_final + v_item_final_amount, 2);

    if v_required_shirt and (coalesce(v_item_shirt_type, '') = '' or coalesce(v_item_shirt_size, '') = '') then
      raise exception 'Camiseta obrigatoria para o ingresso %.', v_item_index;
    end if;

    if v_ownership_status = 'assigned' and not (p_assign_first_to_buyer and v_item_index = 1) then
      v_ownership_status := 'unassigned';
    end if;

    insert into public.order_items (
      order_id,
      event_id,
      participant_id,
      ownership_status,
      ticket_category_id,
      batch_id,
      pricing_gender,
      shirt_type,
      shirt_size,
      quantity,
      unit_price,
      discount_amount,
      final_amount,
      status,
      reservation_expires_at,
      item_position,
      holder_full_name,
      holder_email,
      holder_phone
    ) values (
      v_order_id,
      p_event_id,
      case when p_assign_first_to_buyer and v_item_index = 1 and v_ownership_status = 'assigned' then v_anchor_participant_id else null end,
      case when p_assign_first_to_buyer and v_item_index = 1 and v_ownership_status = 'assigned' then 'assigned' else 'unassigned' end,
      p_ticket_category_id,
      v_pricing.batch_id,
      v_item_pricing_gender,
      v_item_shirt_type,
      v_item_shirt_size,
      1,
      v_item_base_amount,
      v_item_discount_amount,
      v_item_final_amount,
      v_status,
      v_reservation_expires_at,
      v_item_index,
      v_holder_name,
      v_holder_email,
      v_holder_phone
    );
  end loop;

  if p_coupon_code is not null and trim(p_coupon_code) <> '' and v_total_discount > 0 then
    with ranked as (
      select oi.id,
             oi.unit_price,
             round(
               case
                 when v_total_amount <= 0 then 0
                 else (oi.unit_price / v_total_amount) * v_total_discount
               end,
               2
             ) as prorated_discount,
             row_number() over (order by oi.item_position asc, oi.created_at asc) as rn,
             count(*) over () as total_count
      from public.order_items oi
      where oi.order_id = v_order_id
    ), adjusted as (
      select
        id,
        case
          when rn < total_count then prorated_discount
          else round(v_total_discount - coalesce((select sum(prorated_discount) from ranked where rn < total_count), 0), 2)
        end as discount_value
      from ranked
    )
    update public.order_items oi
    set discount_amount = greatest(a.discount_value, 0),
        final_amount = round(greatest(oi.unit_price - greatest(a.discount_value, 0), 0), 2)
    from adjusted a
    where oi.id = a.id;

    select
      round(coalesce(sum(oi.unit_price), 0), 2),
      round(coalesce(sum(oi.discount_amount), 0), 2),
      round(coalesce(sum(oi.final_amount), 0), 2)
    into v_total_amount, v_total_discount, v_total_final
    from public.order_items oi
    where oi.order_id = v_order_id;
  end if;

  for v_stock_req in
    select
      oi.shirt_type,
      oi.shirt_size,
      count(*)::integer as requested_qty
    from public.order_items oi
    where oi.order_id = v_order_id
      and oi.shirt_type is not null
      and oi.shirt_size is not null
    group by oi.shirt_type, oi.shirt_size
  loop
    select * into v_inventory
    from public.shirt_inventory
    where event_id = p_event_id
      and shirt_type = v_stock_req.shirt_type
      and shirt_size = v_stock_req.shirt_size
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para variante % / %.', v_stock_req.shirt_type, v_stock_req.shirt_size;
    end if;

    v_stock_available := coalesce(v_inventory.total_quantity, 0) - coalesce(v_inventory.reserved_quantity, 0) - coalesce(v_inventory.delivered_quantity, 0);

    if v_stock_available < v_stock_req.requested_qty then
      raise exception 'Estoque insuficiente para % / %. Disponivel: %, solicitado: %.',
        v_stock_req.shirt_type,
        v_stock_req.shirt_size,
        v_stock_available,
        v_stock_req.requested_qty;
    end if;
  end loop;

  update public.orders
  set base_amount = v_total_amount,
      discount_amount = v_total_discount,
      final_amount = v_total_final
  where id = v_order_id;

  update public.payments
  set amount = v_total_amount,
      discount_amount = v_total_discount,
      final_amount = v_total_final,
      payment_status = case when lower(trim(coalesce(p_payment_method, ''))) = 'courtesy' or v_total_final <= 0 then 'paid' else 'pending' end,
      paid_at = case when lower(trim(coalesce(p_payment_method, ''))) = 'courtesy' or v_total_final <= 0 then coalesce(paid_at, now()) else null end,
      expires_at = case when lower(trim(coalesce(p_payment_method, ''))) = 'courtesy' or v_total_final <= 0 then null else v_reservation_expires_at end,
      updated_at = now()
  where id = v_payment_id;

  if lower(trim(coalesce(p_payment_method, ''))) = 'courtesy' or v_total_final <= 0 then
    v_payment_status := 'paid';
    v_status := 'confirmed';
    v_reservation_expires_at := null;
  else
    v_payment_status := 'pending';
    v_status := 'reserved';
    v_reservation_expires_at := now() + interval '2 hours';
  end if;

  update public.order_items
  set status = case when v_payment_status = 'paid' then 'confirmed' else 'reserved' end,
      reservation_expires_at = v_reservation_expires_at,
      updated_at = now()
  where order_id = v_order_id;

  if v_payment_status = 'paid' then
    update public.orders
    set status = 'confirmed',
        confirmed_at = coalesce(confirmed_at, now()),
        cancelled_at = null
    where id = v_order_id;

    update public.participants
    set registration_status = 'confirmed',
        reservation_status = 'confirmed',
        reservation_expires_at = null,
        base_amount = v_total_amount,
        discount_amount = v_total_discount,
        final_amount = v_total_final,
        updated_at = now()
    where id = v_anchor_participant_id;
  else
    update public.orders
    set status = 'pending',
        confirmed_at = null,
        cancelled_at = null
    where id = v_order_id;

    update public.participants
    set registration_status = 'pending',
        reservation_status = 'pending',
        reservation_expires_at = v_reservation_expires_at,
        base_amount = v_total_amount,
        discount_amount = v_total_discount,
        final_amount = v_total_final,
        updated_at = now()
    where id = v_anchor_participant_id;
  end if;

  for v_stock_req in
    select
      oi.shirt_type,
      oi.shirt_size,
      count(*)::integer as requested_qty
    from public.order_items oi
    where oi.order_id = v_order_id
      and oi.shirt_type is not null
      and oi.shirt_size is not null
    group by oi.shirt_type, oi.shirt_size
  loop
    select * into v_inventory
    from public.shirt_inventory
    where event_id = p_event_id
      and shirt_type = v_stock_req.shirt_type
      and shirt_size = v_stock_req.shirt_size
    limit 1;

    if found then
      update public.shirt_inventory
      set reserved_quantity = reserved_quantity + v_stock_req.requested_qty,
          updated_at = now()
      where id = v_inventory.id;

      insert into public.inventory_movements (
        event_id,
        inventory_id,
        movement_type,
        quantity,
        notes
      ) values (
        p_event_id,
        v_inventory.id,
        'adjustment',
        -v_stock_req.requested_qty,
        format('Reserva checkout multi (%s) pedido %s para %s/%s.', v_stock_req.requested_qty, v_order_number, v_stock_req.shirt_type, v_stock_req.shirt_size)
      );
    end if;
  end loop;

  if coalesce(v_event.kit_enabled, false) then
    insert into public.participant_kit_items (
      participant_id,
      event_id,
      kit_item_id,
      variant_data,
      quantity,
      status
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
    on conflict (participant_id, kit_item_id)
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
$$;

create or replace function public.get_order_checkout_snapshot(
  p_order_id uuid
)
returns table (
  order_id uuid,
  order_number text,
  order_status text,
  payment_id uuid,
  payment_status text,
  payment_method text,
  amount numeric,
  discount_amount numeric,
  final_amount numeric,
  expires_at timestamptz,
  pix_code text,
  pix_qrcode text,
  gateway_payment_id text,
  paid_at timestamptz,
  event_id uuid,
  event_name text,
  item_id uuid,
  item_position integer,
  item_status text,
  ownership_status text,
  pricing_gender text,
  participant_id uuid,
  participant_name text,
  holder_full_name text,
  ticket_id uuid,
  ticket_status text,
  ticket_token uuid,
  shirt_type text,
  shirt_size text,
  category_name text,
  batch_name text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    o.id as order_id,
    o.order_number,
    o.status as order_status,
    pay.id as payment_id,
    pay.payment_status,
    pay.payment_method,
    pay.amount,
    pay.discount_amount,
    pay.final_amount,
    pay.expires_at,
    pay.pix_code,
    pay.pix_qrcode,
    pay.gateway_payment_id,
    pay.paid_at,
    o.event_id,
    e.name as event_name,
    oi.id as item_id,
    oi.item_position,
    oi.status as item_status,
    oi.ownership_status,
    oi.pricing_gender,
    oi.participant_id,
    p.full_name as participant_name,
    oi.holder_full_name,
    t.id as ticket_id,
    t.status as ticket_status,
    t.token as ticket_token,
    oi.shirt_type,
    oi.shirt_size,
    tc.name as category_name,
    rb.name as batch_name
  from public.orders o
  join public.payments pay
    on pay.order_id = o.id
  join public.order_items oi
    on oi.order_id = o.id
  join public.events e
    on e.id = o.event_id
  left join public.participants p
    on p.id = oi.participant_id
  left join public.tickets t
    on t.order_item_id = oi.id
  left join public.ticket_categories tc
    on tc.id = oi.ticket_category_id
  left join public.registration_batches rb
    on rb.id = oi.batch_id
  where o.id = p_order_id
    and (
      auth.uid() = o.user_id
      or public.current_user_has_permission('participants.view'::text)
    )
  order by coalesce(oi.item_position, 999999), oi.created_at;
$$;

create or replace function public.deliver_kit_and_checkin(
  p_ticket_id uuid
)
returns table (
  success boolean,
  kit_delivered boolean,
  checkin_done boolean,
  message text,
  participant_id uuid,
  event_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ticket public.tickets%rowtype;
  v_participant public.participants%rowtype;
  v_event public.events%rowtype;
  v_pending_kit_count integer := 0;
  v_actor text := coalesce((select email from auth.users where id = auth.uid()), 'system');
begin
  if not public.current_user_has_permission('kits.deliver'::text) then
    raise exception 'Sem permissao para entregar kit.';
  end if;

  if not public.current_user_has_permission('checkin.scan'::text) then
    raise exception 'Sem permissao para realizar check-in.';
  end if;

  if p_ticket_id is null then
    raise exception 'Ticket obrigatorio.';
  end if;

  select * into v_ticket
  from public.tickets
  where id = p_ticket_id
  for update;

  if not found then
    raise exception 'Ticket nao encontrado.';
  end if;

  if v_ticket.participant_id is null then
    return query
    select
      false,
      false,
      false,
      'Ticket sem titular definido. Associe um participante antes da operacao combinada.',
      null,
      v_ticket.event_id;
    return;
  end if;

  select * into v_participant
  from public.participants
  where id = v_ticket.participant_id
  for update;

  if not found then
    raise exception 'Participante nao encontrado para o ticket.';
  end if;

  select * into v_event
  from public.events
  where id = v_participant.event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  if not coalesce(v_event.allow_checkin_during_kit_delivery, false) then
    return query
    select
      false,
      false,
      false,
      'Operacao combinada desativada para este evento.',
      v_participant.id,
      v_participant.event_id;
    return;
  end if;

  if coalesce(v_participant.payment_status, 'pending') <> 'paid' then
    return query
    select
      false,
      false,
      false,
      'Pagamento pendente. Nao e possivel liberar entrada ou entregar o kit.',
      v_participant.id,
      v_participant.event_id;
    return;
  end if;

  if v_ticket.status = 'used' or v_ticket.used_at is not null then
    return query
    select
      false,
      false,
      true,
      format('Entrada ja registrada em %s.', to_char(coalesce(v_ticket.used_at, now()), 'DD/MM/YYYY HH24:MI')),
      v_participant.id,
      v_participant.event_id;
    return;
  end if;

  select count(*)::integer into v_pending_kit_count
  from public.participant_kit_items pki
  where pki.participant_id = v_participant.id
    and pki.status <> 'delivered';

  if v_pending_kit_count = 0 then
    return query
    select
      false,
      true,
      false,
      'Kit ja entregue. Utilize apenas a acao de check-in.',
      v_participant.id,
      v_participant.event_id;
    return;
  end if;

  perform public.deliver_participant_full_kit(v_participant.id);
  perform public.checkin_participant_entry(v_participant.id);

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    v_actor,
    'combined_kit_delivery_and_checkin',
    'tickets',
    v_ticket.id,
    v_participant.event_id,
    jsonb_build_object(
      'origin', 'combined_operation',
      'participant_id', v_participant.id,
      'ticket_id', v_ticket.id
    )
  );

  return query
  select
    true,
    true,
    true,
    'Operador confirmou entrega do kit e entrada em uma unica operacao.',
    v_participant.id,
    v_participant.event_id;
end;
$$;

create or replace function public.checkin_participant_entry(
  p_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.participants%rowtype;
  v_ticket public.tickets%rowtype;
begin
  if not public.current_user_has_permission('checkin.scan'::text) then
    raise exception 'Sem permissao para realizar check-in.';
  end if;

  select * into v_participant
  from public.participants
  where id = p_participant_id;

  if not found then
    raise exception 'Participante nao encontrado.';
  end if;

  if coalesce(v_participant.payment_status, 'pending') <> 'paid' then
    raise exception 'Pagamento pendente. Check-in bloqueado.';
  end if;

  if coalesce(v_participant.registration_status, 'pending') = 'cancelled' then
    raise exception 'Inscricao cancelada. Check-in bloqueado.';
  end if;

  select * into v_ticket
  from public.tickets
  where participant_id = p_participant_id
  order by issued_at desc
  limit 1
  for update;

  if not found then
    raise exception 'Ingresso nao encontrado.';
  end if;

  if v_ticket.status = 'used' or v_ticket.used_at is not null then
    raise exception 'Ingresso ja utilizado anteriormente.';
  end if;

  update public.tickets
  set status = 'used',
      used_at = now()
  where id = v_ticket.id;

  if v_participant.user_id is not null and v_participant.event_id is not null then
    insert into public.participation_history (
      event_id,
      user_id,
      participant_id,
      legacy_event_name,
      event_year,
      full_name,
      normalized_name,
      cpf,
      email,
      status,
      source,
      manually_verified,
      created_at,
      updated_at
    )
    values (
      v_participant.event_id,
      v_participant.user_id,
      v_participant.id,
      null,
      extract(year from coalesce(v_participant.created_at, now()))::integer,
      coalesce(nullif(trim(v_participant.full_name), ''), 'Participante'),
      public.normalize_text_for_match(v_participant.full_name),
      v_participant.cpf,
      v_participant.email,
      'confirmed',
      'system',
      false,
      now(),
      now()
    )
    on conflict do nothing;

    perform public.recalculate_customer_loyalty(v_participant.user_id);
  end if;

  insert into public.audit_logs (
    actor,
    action,
    entity_type,
    entity_id,
    event_id,
    details
  ) values (
    coalesce((select email from auth.users where id = auth.uid()), 'system'),
    'participant_checkin_entry',
    'participants',
    p_participant_id,
    v_participant.event_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id,
      'used_at', now()
    )
  );

  return true;
end;
$$;

grant execute on function public.start_order_payment_pix(uuid, text, text, text, timestamptz) to authenticated;
grant execute on function public.confirm_order_payment_and_issue_tickets(uuid) to authenticated;
grant execute on function public.simulate_order_payment_paid(uuid, text) to authenticated;
grant execute on function public.create_multi_ticket_order_checkout(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text) to authenticated;
grant execute on function public.get_order_checkout_snapshot(uuid) to authenticated;
grant execute on function public.deliver_kit_and_checkin(uuid) to authenticated;
grant execute on function public.checkin_participant_entry(uuid) to authenticated;
