-- P0: checkout lia shirt_inventory.reserved/delivered (legado sujo).
-- /camisetas ja usa total de shirt_inventory + reserved/delivered de
-- event_kit_item_variant_inventory. Entregue nunca volta a ficar disponivel.
--
-- UI: get_event_shirt_stock_for_selection (security definer) — comprador
-- autenticado nao passa na RLS org-only de event_kit_item_variant_inventory.
-- Writer: assert canonico no dispatcher limit_shirt_selection_to_stock=true,
-- com lock FOR UPDATE + pedidos pending ainda nao contabilizados no kit,
-- para duas compras concorrentes da ultima unidade nao passarem as duas.
begin;

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

  -- Sem linha canônica: fail-safe. Nunca usar reserved/delivered legado.
  -- Evento limitado só chama esta função; indisponível até existir kit inventory.
  if not found then
    return 0;
  end if;

  -- Pedidos ativos ainda sem demanda canônica (PIX pending, ticket nao
  -- materializado). Evita oversell concorrente sem double-count com
  -- event_kit_item_variant_inventory.reserved_quantity.
  select coalesce(sum(greatest(coalesce(oi.quantity, 1), 1)), 0)::integer
    into v_pending
  from public.order_items oi
  where oi.event_id = p_event_id
    and coalesce(oi.item_kind, 'ticket') = 'ticket'
    and oi.status not in ('cancelled', 'expired', 'refunded', 'transferred')
    and lower(trim(coalesce(oi.shirt_type, ''))) = lower(v_type)
    and upper(trim(coalesce(oi.shirt_size, ''))) = v_size
    and (p_exclude_order_item_id is null or oi.id <> p_exclude_order_item_id)
    and not exists (
      select 1
      from public.tickets t
      join public.participant_kit_items pki on pki.ticket_id = t.id
      join public.event_kit_items eki on eki.id = pki.kit_item_id and eki.item_type = 'shirt'
      where t.order_item_id = oi.id
        and pki.inventory_reservation_accounted
        and pki.status not in ('cancelled')
    );

  return greatest(v_total - v_delivered - v_reserved - coalesce(v_pending, 0), 0);
end;
$$;

create or replace function public.assert_canonical_shirt_stock_for_new_checkout(
  p_event_id uuid,
  p_quantity integer,
  p_shirt_type text,
  p_shirt_size text,
  p_items jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_available integer;
begin
  for v_row in
    select
      normalized.norm_type as shirt_type,
      normalized.norm_size as shirt_size,
      count(*)::integer as requested_qty
    from generate_series(1, greatest(coalesce(p_quantity, 0), 0)) gs(idx)
    cross join lateral (
      select case
        when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (gs.idx - 1), '{}'::jsonb)
        else '{}'::jsonb
      end as payload
    ) item
    cross join lateral (
      select
        nullif(trim(coalesce(item.payload ->> 'shirt_type', p_shirt_type, '')), '') as raw_type,
        nullif(trim(coalesce(item.payload ->> 'shirt_size', p_shirt_size, '')), '') as raw_size
    ) raw
    cross join lateral (
      select
        case
          when raw.raw_type is null then null
          when lower(raw.raw_type) = 'camiseta' then 'Camiseta'
          when lower(raw.raw_type) = 'babylook' then 'Babylook'
          else initcap(lower(raw.raw_type))
        end as norm_type,
        case when raw.raw_size is null then null else upper(raw.raw_size) end as norm_size
    ) normalized
    where normalized.norm_type is not null
      and normalized.norm_size is not null
    group by normalized.norm_type, normalized.norm_size
    order by normalized.norm_type, normalized.norm_size
  loop
    v_available := public.canonical_shirt_available_for_new_reservation(
      p_event_id, v_row.shirt_type, v_row.shirt_size, null
    );
    if v_available < v_row.requested_qty then
      raise exception 'Estoque insuficiente para a quantidade solicitada (%).', v_row.requested_qty;
    end if;
  end loop;
end;
$$;

-- RPC de leitura para o seletor (checkout autenticado + emissao admin).
-- total: shirt_inventory.total_quantity.
-- reserved/delivered: SOMENTE event_kit_item_variant_inventory.
-- Sem linha canônica + limit_shirt_selection_to_stock: available=0.
-- Sem linha canônica + evento não limitado: não bloqueia (available=total).
-- Nunca usa shirt_inventory.reserved_quantity / delivered_quantity.
create or replace function public.get_event_shirt_stock_for_selection(p_event_id uuid)
returns table (
  shirt_type text,
  shirt_size text,
  total_quantity integer,
  reserved_quantity integer,
  delivered_quantity integer,
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
    case
      when kit.has_canonical then
        greatest(
          coalesce(si.total_quantity, 0)
          - coalesce(kit.delivered_quantity, 0)
          - coalesce(kit.reserved_quantity, 0),
          0
        )::integer
      when coalesce(e.limit_shirt_selection_to_stock, false) then 0
      else greatest(coalesce(si.total_quantity, 0), 0)::integer
    end
  from public.shirt_inventory si
  join public.events e on e.id = si.event_id
  left join lateral (
    select inv.reserved_quantity, inv.delivered_quantity, true as has_canonical
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

create or replace function public.create_multi_ticket_order_checkout_inventory_legacy(
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
) returns table (
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
  v_event public.events%rowtype;
  v_limit_stock boolean := false;
  v_item_index integer;
  v_item_payload jsonb;
  v_raw_type text;
  v_raw_size text;
  v_norm_type text;
  v_norm_size text;
  v_variant record;
  v_inventory public.shirt_inventory%rowtype;
  v_required_total integer;
  v_result record;
begin
  if to_regprocedure('public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)') is null then
    raise exception 'Funcao legacy de checkout nao encontrada.';
  end if;

  if p_event_id is null then
    raise exception 'Evento obrigatorio.';
  end if;

  select * into v_event
  from public.events
  where id = p_event_id
  for update;

  if not found then
    raise exception 'Evento nao encontrado.';
  end if;

  v_limit_stock := coalesce(v_event.limit_shirt_selection_to_stock, false);

  if v_limit_stock then
    perform public.assert_canonical_shirt_stock_for_new_checkout(
      p_event_id, p_quantity, p_shirt_type, p_shirt_size, p_items
    );
    return query
    select *
    from public.create_multi_ticket_order_checkout_legacy(
      p_event_id,
      p_ticket_category_id,
      p_gender,
      p_quantity,
      p_payment_method,
      p_coupon_code,
      p_shirt_type,
      p_shirt_size,
      p_buyer_full_name,
      p_buyer_cpf,
      p_buyer_birth_date,
      p_buyer_gender,
      p_buyer_phone,
      p_buyer_email,
      p_buyer_city,
      p_assign_first_to_buyer,
      p_items,
      p_limit_per_order,
      p_notes,
      p_client_request_id
    );
    return;
  end if;

  create temporary table if not exists pg_temp.tmp_inventory_checkout_boost (
    inventory_id uuid primary key,
    original_total integer not null
  ) on commit drop;

  if to_regclass('pg_temp.tmp_inventory_checkout_boost') is not null then
    execute 'truncate table pg_temp.tmp_inventory_checkout_boost';
  end if;

  for v_item_index in 1..greatest(coalesce(p_quantity, 0), 0) loop
    v_item_payload := case
      when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (v_item_index - 1), '{}'::jsonb)
      else '{}'::jsonb
    end;

    v_raw_type := nullif(trim(coalesce(v_item_payload ->> 'shirt_type', p_shirt_type, '')), '');
    v_raw_size := nullif(trim(coalesce(v_item_payload ->> 'shirt_size', p_shirt_size, '')), '');

    if v_raw_type is null or v_raw_size is null then
      continue;
    end if;

    if lower(v_raw_type) = 'camiseta' then
      v_norm_type := 'Camiseta';
    elsif lower(v_raw_type) = 'babylook' then
      v_norm_type := 'Babylook';
    else
      v_norm_type := initcap(lower(v_raw_type));
    end if;

    v_norm_size := upper(v_raw_size);

    select * into v_inventory
    from public.shirt_inventory si
    where si.event_id = p_event_id
      and upper(trim(si.shirt_type)) = upper(trim(v_norm_type))
      and upper(trim(si.shirt_size)) = upper(trim(v_norm_size))
    for update;

    if not found then
      raise exception 'Estoque nao encontrado para variante % / %.', v_norm_type, v_norm_size;
    end if;

    insert into pg_temp.tmp_inventory_checkout_boost (inventory_id, original_total)
    values (v_inventory.id, coalesce(v_inventory.total_quantity, 0))
    on conflict (inventory_id) do nothing;
  end loop;

  for v_variant in
    select
      v.inventory_id,
      count(*)::integer as requested_qty
    from (
      select
        si.id as inventory_id
      from generate_series(1, greatest(coalesce(p_quantity, 0), 0)) gs(idx)
      cross join lateral (
        select case
          when jsonb_typeof(p_items) = 'array' then coalesce(p_items -> (gs.idx - 1), '{}'::jsonb)
          else '{}'::jsonb
        end as payload
      ) item
      cross join lateral (
        select nullif(trim(coalesce(item.payload ->> 'shirt_type', p_shirt_type, '')), '') as raw_type,
               nullif(trim(coalesce(item.payload ->> 'shirt_size', p_shirt_size, '')), '') as raw_size
      ) raw
      cross join lateral (
        select case
          when raw.raw_type is null then null
          when lower(raw.raw_type) = 'camiseta' then 'Camiseta'
          when lower(raw.raw_type) = 'babylook' then 'Babylook'
          else initcap(lower(raw.raw_type))
        end as norm_type,
        case when raw.raw_size is null then null else upper(raw.raw_size) end as norm_size
      ) normalized
      join public.shirt_inventory si
        on si.event_id = p_event_id
       and upper(trim(si.shirt_type)) = upper(trim(normalized.norm_type))
       and upper(trim(si.shirt_size)) = upper(trim(normalized.norm_size))
      where normalized.norm_type is not null
        and normalized.norm_size is not null
    ) v
    group by v.inventory_id
  loop
    select * into v_inventory
    from public.shirt_inventory
    where id = v_variant.inventory_id
    for update;

    v_required_total := coalesce(v_inventory.reserved_quantity, 0)
      + coalesce(v_inventory.delivered_quantity, 0)
      + coalesce(v_variant.requested_qty, 0);

    if coalesce(v_inventory.total_quantity, 0) < v_required_total then
      update public.shirt_inventory
      set total_quantity = v_required_total,
          updated_at = now()
      where id = v_inventory.id;
    end if;
  end loop;

  begin
    select * into v_result
    from public.create_multi_ticket_order_checkout_legacy(
      p_event_id,
      p_ticket_category_id,
      p_gender,
      p_quantity,
      p_payment_method,
      p_coupon_code,
      p_shirt_type,
      p_shirt_size,
      p_buyer_full_name,
      p_buyer_cpf,
      p_buyer_birth_date,
      p_buyer_gender,
      p_buyer_phone,
      p_buyer_email,
      p_buyer_city,
      p_assign_first_to_buyer,
      p_items,
      p_limit_per_order,
      p_notes,
      p_client_request_id
    )
    limit 1;
  exception
    when others then
      update public.shirt_inventory si
      set total_quantity = boost.original_total,
          updated_at = now()
      from pg_temp.tmp_inventory_checkout_boost boost
      where si.id = boost.inventory_id;
      raise;
  end;

  update public.shirt_inventory si
  set total_quantity = boost.original_total,
      updated_at = now()
  from pg_temp.tmp_inventory_checkout_boost boost
  where si.id = boost.inventory_id;

  return query
  select
    v_result.order_id,
    v_result.payment_id,
    v_result.order_number,
    v_result.payment_status,
    v_result.reservation_expires_at,
    v_result.item_count,
    v_result.amount,
    v_result.discount_amount,
    v_result.final_amount;
end;
$$;

create or replace function public.change_pending_order_item_shirt(
  p_order_id uuid, p_order_item_id uuid, p_shirt_type text, p_shirt_size text
) returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_event public.events%rowtype;
  v_new_type text := nullif(trim(coalesce(p_shirt_type, '')), '');
  v_new_size text := nullif(trim(coalesce(p_shirt_size, '')), '');
  v_old_inventory public.shirt_inventory%rowtype;
  v_new_inventory public.shirt_inventory%rowtype;
  v_row public.shirt_inventory%rowtype;
  v_available_stock integer;
  v_enforce_physical_stock boolean;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if v_new_type is null or v_new_size is null then
    raise exception 'Informe o tipo e o tamanho da camiseta.';
  end if;

  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item do pedido nao encontrado.'; end if;
  if v_item.order_id is distinct from p_order_id then
    raise exception 'Item nao pertence a este pedido.';
  end if;
  if v_item.item_kind <> 'ticket' then
    raise exception 'Somente ingressos tem camiseta editavel por aqui.';
  end if;
  if v_item.status in ('cancelled','expired','refunded','transferred') then
    raise exception 'Item nao esta mais ativo neste pedido.';
  end if;

  select * into v_order from public.orders where id = v_item.order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;
  if v_order.status <> 'pending' then
    raise exception 'Pedido nao esta mais no carrinho.';
  end if;

  select * into v_event from public.events where id = v_order.event_id;
  v_enforce_physical_stock := coalesce(v_event.limit_shirt_selection_to_stock, false);

  select * into v_payment from public.payments where order_id = v_order.id order by created_at desc limit 1 for update;
  if found then
    if v_payment.payment_status <> 'pending' then
      raise exception 'Pedido nao esta mais no carrinho.';
    end if;
    if v_payment.expires_at is not null and v_payment.expires_at <= now() then
      raise exception 'O prazo de reserva deste pedido ja expirou.';
    end if;
  end if;

  if v_new_type = v_item.shirt_type and v_new_size = v_item.shirt_size then
    select jsonb_build_object(
      'order_id', v_order.id, 'order_item_id', p_order_item_id,
      'shirt_type', v_item.shirt_type, 'shirt_size', v_item.shirt_size, 'changed', false
    ) into v_result;
    return v_result;
  end if;

  for v_row in
    select * from public.shirt_inventory
    where event_id = v_order.event_id
      and ((shirt_type = v_item.shirt_type and shirt_size = v_item.shirt_size)
        or (shirt_type = v_new_type and shirt_size = v_new_size))
    order by id
    for update
  loop
    if v_row.shirt_type = v_item.shirt_type and v_row.shirt_size = v_item.shirt_size then
      v_old_inventory := v_row;
    end if;
    if v_row.shirt_type = v_new_type and v_row.shirt_size = v_new_size then
      v_new_inventory := v_row;
    end if;
  end loop;

  if v_new_inventory.id is null then
    raise exception 'Estoque nao encontrado para este modelo e tamanho.';
  end if;

  -- Troca: exclui a propria linha do pedido para nao contar a reserva atual
  -- contra o tamanho novo. Nao usa shirt_inventory.reserved_quantity legado.
  v_available_stock := public.canonical_shirt_available_for_new_reservation(
    v_order.event_id, v_new_type, v_new_size, p_order_item_id
  );
  if v_enforce_physical_stock and v_available_stock < 1 then
    raise exception 'Estoque insuficiente para o modelo/tamanho selecionado.';
  end if;

  if v_old_inventory.id is not null then
    update public.shirt_inventory
    set reserved_quantity = greatest(reserved_quantity - 1, 0), updated_at = now()
    where id = v_old_inventory.id;

    insert into public.inventory_movements(event_id, inventory_id, movement_type, quantity, notes)
    values (v_order.event_id, v_old_inventory.id, 'adjustment', 1,
      format('Troca de camiseta (edicao de pedido pending) pedido %s: liberou %s/%s.', v_order.order_number, v_old_inventory.shirt_type, v_old_inventory.shirt_size));
  end if;

  update public.shirt_inventory
  set reserved_quantity = reserved_quantity + 1, updated_at = now()
  where id = v_new_inventory.id;

  insert into public.inventory_movements(event_id, inventory_id, movement_type, quantity, notes)
  values (v_order.event_id, v_new_inventory.id, 'adjustment', -1,
    format('Troca de camiseta (edicao de pedido pending) pedido %s: reservou %s/%s.', v_order.order_number, v_new_type, v_new_size));

  update public.order_items
  set shirt_type = v_new_type, shirt_size = v_new_size, updated_at = now()
  where id = p_order_item_id;

  perform public.apply_cart_coupon(v_order.id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('order_item_shirt_changed', 'order_items', p_order_item_id, v_order.event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'order_id', v_order.id, 'order_item_id', p_order_item_id,
    'previous_shirt_type', v_item.shirt_type, 'previous_shirt_size', v_item.shirt_size,
    'new_shirt_type', v_new_type, 'new_shirt_size', v_new_size));

  select jsonb_build_object(
    'order_id', v_order.id, 'order_item_id', p_order_item_id,
    'shirt_type', v_new_type, 'shirt_size', v_new_size, 'changed', true
  ) into v_result;
  return v_result;
end; $$;

revoke all on function public.canonical_shirt_available_for_new_reservation(uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.assert_canonical_shirt_stock_for_new_checkout(uuid, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.get_event_shirt_stock_for_selection(uuid) from public;
grant execute on function public.get_event_shirt_stock_for_selection(uuid) to anon, authenticated;
revoke all on function public.create_multi_ticket_order_checkout_inventory_legacy(
  uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text
) from public, anon, authenticated;
revoke all on function public.change_pending_order_item_shirt(uuid, uuid, text, text) from public, anon;
grant execute on function public.change_pending_order_item_shirt(uuid, uuid, text, text) to authenticated;

commit;
