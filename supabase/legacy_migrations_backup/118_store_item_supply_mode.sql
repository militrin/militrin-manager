-- 118_store_item_supply_mode.sql
-- Permite que cada item da Loja do Evento seja "estoque limitado" (respeita
-- store_item_inventory.total_quantity, como ja funciona) ou "por encomenda"
-- (sem limite de quantidade, produzido sob demanda apos a compra - mesmo
-- conceito de shirt_supply_mode='made_to_order' ja usado para camiseta).

begin;

alter table public.store_items add column if not exists supply_mode text not null default 'stock'
  check (supply_mode in ('stock', 'made_to_order'));

-- Mudou a lista de colunas de retorno (supply_mode no meio); precisa dropar.
drop function if exists public.list_store_items_for_event(uuid);

create or replace function public.list_store_items_for_event(p_event_id uuid)
returns table (
  store_item_id uuid, name text, slug text, description text, image_url text, price numeric, requires_variant boolean,
  supply_mode text, sort_order integer, variant_id uuid, variant_name text, variant_value text, price_adjustment numeric,
  total_quantity integer, reserved_quantity integer, delivered_quantity integer, available_quantity integer
)
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select si.id, si.name, si.slug, si.description, si.image_url, si.price, si.requires_variant, si.supply_mode, si.sort_order,
    siv.id, siv.name, siv.value, siv.price_adjustment,
    coalesce(inv.total_quantity, 0), coalesce(inv.reserved_quantity, 0), coalesce(inv.delivered_quantity, 0),
    case when si.supply_mode = 'made_to_order' then null
      else greatest(coalesce(inv.total_quantity, 0) - coalesce(inv.reserved_quantity, 0) - coalesce(inv.delivered_quantity, 0), 0)
    end
  from public.store_items si
  left join public.store_item_variants siv on siv.store_item_id = si.id and siv.is_active
  left join public.store_item_inventory inv on inv.store_item_id = si.id and inv.variant_id is not distinct from siv.id
  where si.event_id = p_event_id and si.is_active
  order by si.sort_order, si.name, siv.sort_order, siv.name;
$$;

grant execute on function public.list_store_items_for_event(uuid) to authenticated, anon;

-- A assinatura mudou (novo parametro p_supply_mode no fim); precisa dropar a
-- versao antiga.
drop function if exists public.upsert_store_item(uuid, uuid, text, text, text, text, numeric, boolean, boolean, integer);

create or replace function public.upsert_store_item(
  p_id uuid, p_event_id uuid, p_name text, p_slug text, p_description text, p_image_url text,
  p_price numeric, p_requires_variant boolean, p_is_active boolean, p_sort_order integer, p_supply_mode text default 'stock'
)
returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_event public.events%rowtype; v_id uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_event from public.events where id = p_event_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome obrigatorio.'; end if;
  if nullif(trim(coalesce(p_slug, '')), '') is null then raise exception 'Slug obrigatorio.'; end if;
  if p_price < 0 then raise exception 'Preco invalido.'; end if;
  if coalesce(p_supply_mode, 'stock') not in ('stock', 'made_to_order') then raise exception 'Modo de fornecimento invalido: %.', p_supply_mode; end if;

  if p_id is null then
    insert into public.store_items (event_id, name, slug, description, image_url, price, requires_variant, is_active, sort_order, supply_mode)
    values (p_event_id, trim(p_name), trim(p_slug), nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_image_url, '')), ''),
      p_price, coalesce(p_requires_variant, false), coalesce(p_is_active, true), coalesce(p_sort_order, 0), coalesce(p_supply_mode, 'stock'))
    returning id into v_id;
  else
    update public.store_items set
      name = trim(p_name), slug = trim(p_slug), description = nullif(trim(coalesce(p_description, '')), ''),
      image_url = nullif(trim(coalesce(p_image_url, '')), ''),
      price = p_price, requires_variant = coalesce(p_requires_variant, false), is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), supply_mode = coalesce(p_supply_mode, 'stock'), updated_at = now()
    where id = p_id and event_id = p_event_id
    returning id into v_id;
    if v_id is null then raise exception 'Item da loja nao encontrado.'; end if;
  end if;
  return v_id;
end; $$;

grant execute on function public.upsert_store_item(uuid, uuid, text, text, text, text, numeric, boolean, boolean, integer, text) to authenticated;

-- create_store_order: itens "por encomenda" nao verificam nem reservam estoque.
create or replace function public.create_store_order(p_event_id uuid, p_items jsonb, p_payment_method text, p_notes text default null)
returns table (store_order_id uuid, order_number text, final_amount numeric)
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_event public.events%rowtype; v_order_id uuid; v_order_number text;
  v_item record; v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype; v_inv public.store_item_inventory%rowtype;
  v_unit_price numeric; v_line_total numeric; v_total numeric := 0; v_paid boolean; v_participant_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_event from public.events where id = p_event_id;
  if not found then raise exception 'Evento invalido.'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Nenhum item selecionado.'; end if;

  v_paid := lower(trim(coalesce(p_payment_method, ''))) = 'courtesy';
  select id into v_participant_id from public.participants where user_id = v_actor and event_id = p_event_id order by created_at desc limit 1;
  v_order_number := 'LOJA-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.store_orders (event_id, user_id, participant_id, order_number, status, payment_method, payment_status, base_amount, final_amount, notes, confirmed_at)
  values (p_event_id, v_actor, v_participant_id, v_order_number, case when v_paid then 'confirmed' else 'pending' end,
    nullif(trim(coalesce(p_payment_method, '')), ''), case when v_paid then 'paid' else 'pending' end,
    0, 0, nullif(trim(coalesce(p_notes, '')), ''), case when v_paid then now() end)
  returning id into v_order_id;

  for v_item in select * from jsonb_to_recordset(p_items) as x(store_item_id uuid, variant_id uuid, quantity integer) loop
    if coalesce(v_item.quantity, 0) <= 0 then raise exception 'Quantidade invalida para item %.', v_item.store_item_id; end if;
    select * into v_store_item from public.store_items where id = v_item.store_item_id and event_id = p_event_id and is_active;
    if not found then raise exception 'Item % indisponivel para este evento.', v_item.store_item_id; end if;
    if v_store_item.requires_variant and v_item.variant_id is null then raise exception 'Item % exige selecao de variante.', v_store_item.name; end if;

    v_unit_price := v_store_item.price;
    if v_item.variant_id is not null then
      select * into v_variant from public.store_item_variants where id = v_item.variant_id and store_item_id = v_store_item.id and is_active;
      if not found then raise exception 'Variante invalida para o item %.', v_store_item.name; end if;
      v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
    end if;

    if v_store_item.supply_mode = 'stock' then
      select * into v_inv from public.store_item_inventory where store_item_id = v_store_item.id and variant_id is not distinct from v_item.variant_id for update;
      if not found or (v_inv.total_quantity - v_inv.reserved_quantity - v_inv.delivered_quantity) < v_item.quantity then
        raise exception 'Estoque insuficiente para %.', v_store_item.name;
      end if;
      update public.store_item_inventory set reserved_quantity = reserved_quantity + v_item.quantity, updated_at = now() where id = v_inv.id;
    end if;

    v_line_total := v_unit_price * v_item.quantity;
    v_total := v_total + v_line_total;
    insert into public.store_order_items (store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status)
    values (v_order_id, v_store_item.id, v_item.variant_id, v_item.quantity, v_unit_price, v_line_total, case when v_paid then 'confirmed' else 'reserved' end);
  end loop;

  update public.store_orders set base_amount = v_total, final_amount = v_total, updated_at = now() where id = v_order_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_created', 'store_orders', v_order_id, p_event_id, jsonb_build_object('actor_user_id', v_actor, 'final_amount', v_total, 'payment_method', p_payment_method));

  return query select v_order_id, v_order_number, v_total;
end; $$;

grant execute on function public.create_store_order(uuid, jsonb, text, text) to authenticated;

-- deliver/undo: so tocam store_item_inventory quando o item e "stock"
-- (para "made_to_order" nao ha linha de estoque, entao o update so afeta
-- 0 linhas - mas deixamos explicito para ficar claro e evitar updates aa toa).
create or replace function public.deliver_store_order_item(p_store_order_item_id uuid)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype; v_item public.store_items%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para entregar itens da loja.'; end if;
  select * into v_line from public.store_order_items where id = p_store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_line.status = 'delivered' then return true; end if;
  if v_line.status <> 'confirmed' then raise exception 'Item precisa estar confirmado (pago) para ser entregue.'; end if;
  select * into v_item from public.store_items where id = v_line.store_item_id;

  if v_item.supply_mode = 'stock' then
    update public.store_item_inventory set reserved_quantity = greatest(reserved_quantity - v_line.quantity, 0),
      delivered_quantity = delivered_quantity + v_line.quantity, updated_at = now()
    where store_item_id = v_line.store_item_id and variant_id is not distinct from v_line.variant_id;
  end if;
  update public.store_order_items set status = 'delivered', delivered_at = now() where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivered', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object('actor_user_id', auth.uid()));
  return true;
end; $$;

grant execute on function public.deliver_store_order_item(uuid) to authenticated;

create or replace function public.undo_store_order_item_delivery(p_store_order_item_id uuid)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype; v_item public.store_items%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para desfazer entrega da loja.'; end if;
  select * into v_line from public.store_order_items where id = p_store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_line.status <> 'delivered' then raise exception 'Item nao esta entregue.'; end if;
  select * into v_item from public.store_items where id = v_line.store_item_id;

  if v_item.supply_mode = 'stock' then
    update public.store_item_inventory set delivered_quantity = greatest(delivered_quantity - v_line.quantity, 0),
      reserved_quantity = reserved_quantity + v_line.quantity, updated_at = now()
    where store_item_id = v_line.store_item_id and variant_id is not distinct from v_line.variant_id;
  end if;
  update public.store_order_items set status = 'confirmed', delivered_at = null where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivery_undone', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object('actor_user_id', auth.uid()));
  return true;
end; $$;

grant execute on function public.undo_store_order_item_delivery(uuid) to authenticated;

commit;
