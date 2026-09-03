-- FEATURE (2/10): as 3 RPCs que criam linha de produto (carrinho "compre
-- junto", checkout da loja standalone, concessao administrativa) passam a
-- gravar o snapshot pickup_qr_mode (lido de store_items.pickup_qr_mode no
-- momento da criacao da linha) e a materializar unidades em
-- order_item_pickup_units/store_order_item_pickup_units quando o modo e
-- 'per_unit' -- SEMPRE, inclusive quantity=1 (modelo unico, ver comentario
-- da migration 1). Isso elimina o caso de borda que uma versao anterior
-- desta feature precisava tratar explicitamente (linha comecando com
-- quantity=1 sem unidade, depois consolidada pra quantity>1): agora
-- QUALQUER insercao ou consolidacao de uma linha per_unit sempre tem pelo
-- menos 1 unidade, entao consolidar so precisa continuar o unit_index a
-- partir do maximo existente, sem excecao.
begin;

-- ============================================================
-- 1) add_product_to_cart_order -- redefinida a partir da versao vigente
--    (20260916000000).
-- ============================================================
create or replace function public.add_product_to_cart_order(p_order_id uuid, p_store_item_id uuid, p_variant_id uuid default null, p_quantity integer default 1)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_store_item public.store_items%rowtype;
  v_variant public.store_item_variants%rowtype;
  v_base_unit_price numeric; v_unit_price numeric; v_existing public.order_items%rowtype; v_item_id uuid; v_new_quantity integer;
  v_max_unit_index integer; v_i integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;

  select * into v_store_item from public.store_items where id = p_store_item_id
    and (event_id = v_order.event_id or event_id is null) and is_active and organization_id = v_order.organization_id;
  if not found then raise exception 'Produto indisponivel para este pedido.'; end if;
  if v_store_item.visibility <> 'public' then raise exception 'Produto nao esta disponivel para compra publica.'; end if;
  if v_store_item.requires_variant and p_variant_id is null then raise exception 'Produto exige selecao de variante.'; end if;

  v_base_unit_price := v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o produto.'; end if;
    v_base_unit_price := v_base_unit_price + coalesce(v_variant.price_adjustment, 0);
  end if;
  v_unit_price := public.compute_store_item_final_price(v_base_unit_price, v_store_item.discount_type, v_store_item.discount_value);

  select * into v_existing from public.order_items where order_id = p_order_id and item_kind = 'product'
    and store_item_id = v_store_item.id and store_item_variant_id is not distinct from p_variant_id
    and status not in ('cancelled','expired','refunded','transferred') for update;

  perform public.reserve_store_item_stock(v_store_item.id, p_variant_id, p_quantity);

  if found and v_existing.id is not null then
    v_new_quantity := v_existing.quantity + p_quantity;
    update public.order_items
      set quantity = v_new_quantity, unit_price = v_unit_price, product_base_unit_price = v_base_unit_price,
        final_amount = round(v_unit_price * v_new_quantity, 2), updated_at = now()
      where id = v_existing.id
      returning id into v_item_id;

    -- Modelo unico: linha per_unit SEMPRE ja tem pelo menos 1 unidade
    -- (materializada no INSERT original, inclusive se comecou com
    -- quantity=1) -- consolidar so continua o unit_index a partir do
    -- maximo existente, sem excecao/caso de borda.
    if v_existing.pickup_qr_mode = 'per_unit' then
      select coalesce(max(unit_index), 0) into v_max_unit_index from public.order_item_pickup_units where order_item_id = v_item_id;
      for v_i in (v_max_unit_index + 1)..(v_max_unit_index + p_quantity) loop
        insert into public.order_item_pickup_units(order_item_id, unit_index, qr_token, status)
        values (v_item_id, v_i, 'UNIT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), 'reserved');
      end loop;
    end if;
  else
    insert into public.order_items(order_id, event_id, item_kind, store_item_id, store_item_variant_id, quantity, unit_price, product_base_unit_price, discount_amount, final_amount, status, ownership_status, qr_token, pickup_qr_mode)
    values(p_order_id, v_order.event_id, 'product', v_store_item.id, p_variant_id, p_quantity, v_unit_price, v_base_unit_price, 0, round(v_unit_price * p_quantity, 2), 'reserved', 'unassigned',
      'ITEM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), v_store_item.pickup_qr_mode)
    returning id into v_item_id;

    if v_store_item.pickup_qr_mode = 'per_unit' then
      for v_i in 1..p_quantity loop
        insert into public.order_item_pickup_units(order_item_id, unit_index, qr_token, status)
        values (v_item_id, v_i, 'UNIT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), 'reserved');
      end loop;
    end if;
  end if;

  perform public.apply_cart_coupon(p_order_id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_added', 'orders', p_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'store_item_id', v_store_item.id, 'variant_id', p_variant_id, 'quantity_added', p_quantity, 'order_item_id', v_item_id, 'base_unit_price', v_base_unit_price, 'unit_price', v_unit_price));

  return jsonb_build_object('order_item_ids', array[v_item_id], 'unit_price', v_unit_price);
end; $$;

-- ============================================================
-- 2) create_store_order -- redefinida a partir da versao vigente
--    (20260867000000). Sempre INSERT de linha nova (nunca consolida --
--    cada chamada cria um pedido novo do zero), entao a materializacao de
--    unidades e sempre "do zero", sem caso de borda de consolidacao.
-- ============================================================
create or replace function public.create_store_order(p_event_id uuid, p_items jsonb, p_payment_method text, p_notes text default null)
returns table(store_order_id uuid, order_number text, final_amount numeric)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_actor uuid := auth.uid(); v_event public.events%rowtype; v_order_id uuid; v_order_number text;
  v_item record; v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_unit_price numeric; v_final_unit_price numeric; v_line_total numeric; v_total numeric := 0; v_paid boolean; v_participant_id uuid;
  v_organization_id uuid; v_item_id uuid; v_i integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Nenhum item selecionado.'; end if;

  if p_event_id is not null then
    select * into v_event from public.events where id = p_event_id;
    if not found then raise exception 'Evento invalido.'; end if;
    select id into v_participant_id from public.participants where user_id = v_actor and event_id = p_event_id order by created_at desc limit 1;
  else
    select si.organization_id into v_organization_id
    from public.store_items si
    join jsonb_to_recordset(p_items) as x(store_item_id uuid, variant_id uuid, quantity integer) on x.store_item_id = si.id
    where si.event_id is null and si.is_active
    limit 1;
    if v_organization_id is null then raise exception 'Nenhum item valido para pedido sem evento.'; end if;
    v_participant_id := null;
  end if;

  v_paid := lower(trim(coalesce(p_payment_method, ''))) = 'courtesy';
  v_order_number := 'LOJA-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.store_orders (event_id, organization_id, user_id, participant_id, order_number, status, payment_method, payment_status, base_amount, final_amount, notes, confirmed_at)
  values (p_event_id, v_organization_id, v_actor, v_participant_id, v_order_number, case when v_paid then 'confirmed' else 'pending' end,
    nullif(trim(coalesce(p_payment_method, '')), ''), case when v_paid then 'paid' else 'pending' end,
    0, 0, nullif(trim(coalesce(p_notes, '')), ''), case when v_paid then now() end)
  returning id into v_order_id;

  for v_item in select * from jsonb_to_recordset(p_items) as x(store_item_id uuid, variant_id uuid, quantity integer) loop
    if coalesce(v_item.quantity, 0) <= 0 then raise exception 'Quantidade invalida para item %.', v_item.store_item_id; end if;

    if p_event_id is not null then
      select * into v_store_item from public.store_items where id = v_item.store_item_id and (event_id = p_event_id or event_id is null) and is_active;
    else
      select * into v_store_item from public.store_items where id = v_item.store_item_id and event_id is null and is_active and organization_id = v_organization_id;
    end if;
    if not found then raise exception 'Item % indisponivel.', v_item.store_item_id; end if;
    if v_store_item.visibility <> 'public' then raise exception 'Item % nao esta disponivel para compra publica.', v_store_item.name; end if;
    if v_store_item.requires_variant and v_item.variant_id is null then raise exception 'Item % exige selecao de variante.', v_store_item.name; end if;

    v_unit_price := v_store_item.price;
    if v_item.variant_id is not null then
      select * into v_variant from public.store_item_variants where id = v_item.variant_id and store_item_id = v_store_item.id and is_active;
      if not found then raise exception 'Variante invalida para o item %.', v_store_item.name; end if;
      v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
    end if;
    v_final_unit_price := public.compute_store_item_final_price(v_unit_price, v_store_item.discount_type, v_store_item.discount_value);

    perform public.reserve_store_item_stock(v_store_item.id, v_item.variant_id, v_item.quantity);

    v_line_total := v_final_unit_price * v_item.quantity;
    v_total := v_total + v_line_total;
    insert into public.store_order_items (store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status, discount_type, discount_value, final_unit_price, pickup_qr_mode)
    values (v_order_id, v_store_item.id, v_item.variant_id, v_item.quantity, v_unit_price, v_line_total, case when v_paid then 'confirmed' else 'reserved' end,
      v_store_item.discount_type, v_store_item.discount_value, v_final_unit_price, v_store_item.pickup_qr_mode)
    returning id into v_item_id;

    if v_store_item.pickup_qr_mode = 'per_unit' then
      for v_i in 1..v_item.quantity loop
        insert into public.store_order_item_pickup_units(store_order_item_id, unit_index, qr_token, status)
        values (v_item_id, v_i, 'UNIT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), case when v_paid then 'confirmed' else 'reserved' end);
      end loop;
    end if;
  end loop;

  update public.store_orders set base_amount = v_total, final_amount = v_total, updated_at = now() where id = v_order_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_created', 'store_orders', v_order_id, p_event_id, jsonb_build_object('actor_user_id', v_actor, 'final_amount', v_total, 'payment_method', p_payment_method));

  return query select v_order_id, v_order_number, v_total;
end; $$;

-- ============================================================
-- 3) admin_grant_store_item_to_contact -- redefinida a partir da versao
--    vigente (20260859000000). Unica chamadora real de INSERT em
--    store_order_items no caminho administrativo (admin_grant_store_item e
--    so um wrapper que delega pra ela) -- mesma logica "sempre do zero" de
--    create_store_order.
-- ============================================================
create or replace function public.admin_grant_store_item_to_contact(
  p_contact_id uuid, p_event_id uuid, p_store_item_id uuid, p_variant_id uuid,
  p_quantity integer, p_is_courtesy boolean, p_reason text default null
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_contact public.registration_contacts%rowtype; v_event public.events%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_participant_id uuid; v_user_id uuid; v_unit_price numeric; v_final_unit_price numeric;
  v_line_total numeric; v_order_id uuid; v_order_number text; v_item_id uuid; v_i integer;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if v_actor is null or not (
    public.current_user_has_permission('store.grant_items')
    or public.current_user_has_permission('store.manage')
  ) then raise exception 'Sem permissao para conceder itens da loja.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;

  select * into v_contact from public.registration_contacts where id = p_contact_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_contact.organization_id) then
    raise exception 'Cadastro invalido ou sem acesso.';
  end if;
  select * into v_event from public.events where id = p_event_id;
  if not found or v_event.organization_id <> v_contact.organization_id
    or not public.user_can_access_organization(v_actor, v_event.organization_id) then
    raise exception 'Evento invalido, de outra organizacao ou sem acesso.';
  end if;

  select * into v_store_item from public.store_items where id = p_store_item_id
    and organization_id = v_contact.organization_id and (event_id = p_event_id or event_id is null) and is_active;
  if not found then raise exception 'Item da loja indisponivel para este evento ou organizacao.'; end if;
  if v_store_item.requires_variant and p_variant_id is null then raise exception 'Item exige selecao de variante.'; end if;

  v_unit_price := v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants
      where id = p_variant_id and store_item_id = v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o item.'; end if;
    v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
  end if;
  v_final_unit_price := public.compute_store_item_final_price(v_unit_price, v_store_item.discount_type, v_store_item.discount_value);

  perform public.reserve_store_item_stock(v_store_item.id, p_variant_id, p_quantity);

  select p.id, p.user_id into v_participant_id, v_user_id
  from public.participants p
  where p.registration_contact_id = p_contact_id and p.event_id = p_event_id
  order by p.created_at desc limit 1;

  v_line_total := case when coalesce(p_is_courtesy, false) then 0 else round(v_final_unit_price * p_quantity, 2) end;
  v_order_number := 'ADMIN-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.store_orders (
    organization_id, event_id, user_id, participant_id, registration_contact_id,
    order_number, status, payment_method, payment_status, base_amount, final_amount, notes, confirmed_at
  ) values (
    v_contact.organization_id, p_event_id, v_user_id, v_participant_id, v_contact.id,
    v_order_number, case when coalesce(p_is_courtesy, false) then 'confirmed' else 'pending' end,
    case when coalesce(p_is_courtesy, false) then 'admin_courtesy' else 'admin_charge' end,
    case when coalesce(p_is_courtesy, false) then 'paid' else 'pending' end,
    v_line_total, v_line_total, nullif(trim(coalesce(p_reason, '')), ''),
    case when coalesce(p_is_courtesy, false) then now() end
  ) returning id into v_order_id;

  insert into public.store_order_items (
    store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status,
    discount_type, discount_value, final_unit_price, pickup_qr_mode
  ) values (
    v_order_id, v_store_item.id, p_variant_id, p_quantity,
    case when coalesce(p_is_courtesy, false) then 0 else v_unit_price end, v_line_total,
    case when coalesce(p_is_courtesy, false) then 'confirmed' else 'reserved' end,
    v_store_item.discount_type, v_store_item.discount_value,
    case when coalesce(p_is_courtesy, false) then 0 else v_final_unit_price end,
    v_store_item.pickup_qr_mode
  ) returning id into v_item_id;

  if v_store_item.pickup_qr_mode = 'per_unit' then
    for v_i in 1..p_quantity loop
      insert into public.store_order_item_pickup_units(store_order_item_id, unit_index, qr_token, status)
      values (v_item_id, v_i, 'UNIT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), case when coalesce(p_is_courtesy, false) then 'confirmed' else 'reserved' end);
    end loop;
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values ('store_item_admin_granted', 'store_order_items', v_item_id, p_event_id,
    jsonb_build_object('actor_user_id', v_actor, 'actor_email', v_actor_email,
      'registration_contact_id', v_contact.id, 'participant_id', v_participant_id,
      'store_order_id', v_order_id, 'store_item_id', v_store_item.id, 'store_item_name', v_store_item.name,
      'variant_id', p_variant_id, 'quantity', p_quantity, 'is_courtesy', coalesce(p_is_courtesy, false),
      'unit_price', v_unit_price, 'final_amount', v_line_total, 'origin', 'admin_contact',
      'reason', nullif(trim(coalesce(p_reason,'')),''), 'linked_event_kit_item_id', v_store_item.linked_event_kit_item_id));
  return v_item_id;
end; $$;

commit;
