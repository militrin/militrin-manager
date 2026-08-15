-- 120_store_items_all_events_scope.sql
-- Permite que um item da Loja do Evento seja oferecido em "todos os eventos"
-- da organizacao (event_id nulo) em vez de ficar preso a um unico evento.
-- O estoque continua sendo um pool unico por item/variante (o indice unico
-- de store_item_inventory ja ignora event_id), entao nao precisa mudar.

begin;

alter table public.store_items alter column event_id drop not null;
alter table public.store_item_inventory alter column event_id drop not null;

-- ============================================================
-- 1. Triggers de organization_id: precisam funcionar com event_id nulo.
-- ============================================================

create or replace function public.trg_store_items_set_org()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  if NEW.event_id is not null then
    select organization_id into v_org from public.events where id = NEW.event_id;
    if not found or v_org is null then raise exception 'Evento % nao encontrado ou sem organization_id.', NEW.event_id; end if;
    if NEW.organization_id is not null and NEW.organization_id <> v_org then raise exception 'organization_id divergente em store_items (esperado %).', v_org; end if;
    NEW.organization_id := v_org;
  elsif NEW.organization_id is null then
    raise exception 'organization_id obrigatorio para item disponivel em todos os eventos.';
  end if;
  return NEW;
end; $$;

-- Deriva de store_items (via store_item_id) em vez de events (via event_id):
-- assim continua funcionando mesmo quando o item e global (event_id nulo).
create or replace function public.trg_store_item_inventory_set_org()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.store_items where id = NEW.store_item_id;
  if not found or v_org is null then raise exception 'Item da loja % nao encontrado ou sem organization_id.', NEW.store_item_id; end if;
  if NEW.organization_id is not null and NEW.organization_id <> v_org then raise exception 'organization_id divergente em store_item_inventory (esperado %).', v_org; end if;
  NEW.organization_id := v_org;
  return NEW;
end; $$;

-- ============================================================
-- 2. list_store_items_for_event: inclui itens globais (event_id nulo) alem
--    dos especificos do evento pedido; retorna event_id para a UI indicar
--    "Todos os eventos" quando aplicavel.
-- ============================================================

drop function if exists public.list_store_items_for_event(uuid);

create or replace function public.list_store_items_for_event(p_event_id uuid)
returns table (
  store_item_id uuid, event_id uuid, name text, slug text, description text, image_url text, price numeric, requires_variant boolean,
  supply_mode text, sort_order integer, variant_id uuid, variant_name text, variant_value text, price_adjustment numeric,
  total_quantity integer, reserved_quantity integer, delivered_quantity integer, available_quantity integer
)
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select si.id, si.event_id, si.name, si.slug, si.description, si.image_url, si.price, si.requires_variant, si.supply_mode, si.sort_order,
    siv.id, siv.name, siv.value, siv.price_adjustment,
    coalesce(inv.total_quantity, 0), coalesce(inv.reserved_quantity, 0), coalesce(inv.delivered_quantity, 0),
    case when si.supply_mode = 'made_to_order' then null
      else greatest(coalesce(inv.total_quantity, 0) - coalesce(inv.reserved_quantity, 0) - coalesce(inv.delivered_quantity, 0), 0)
    end
  from public.store_items si
  left join public.store_item_variants siv on siv.store_item_id = si.id and siv.is_active
  left join public.store_item_inventory inv on inv.store_item_id = si.id and inv.variant_id is not distinct from siv.id
  where (si.event_id = p_event_id or si.event_id is null) and si.is_active
  order by si.sort_order, si.name, siv.sort_order, siv.name;
$$;

grant execute on function public.list_store_items_for_event(uuid) to authenticated, anon;

-- ============================================================
-- 3. upsert_store_item: novo parametro p_available_all_events. Quando true,
--    o item fica com event_id nulo (oferecido em todos os eventos da mesma
--    organizacao). Edicao agora autoriza pela organizacao do item existente,
--    nao mais exigindo que p_event_id bata com o event_id ja salvo -- assim
--    um item ja global pode ser editado a partir de qualquer evento.
-- ============================================================

drop function if exists public.upsert_store_item(uuid, uuid, text, text, text, text, numeric, boolean, boolean, integer, text);

create or replace function public.upsert_store_item(
  p_id uuid, p_event_id uuid, p_name text, p_slug text, p_description text, p_image_url text,
  p_price numeric, p_requires_variant boolean, p_is_active boolean, p_sort_order integer, p_supply_mode text default 'stock',
  p_available_all_events boolean default false
)
returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_event public.events%rowtype; v_existing public.store_items%rowtype; v_id uuid; v_org uuid; v_stored_event_id uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome obrigatorio.'; end if;
  if nullif(trim(coalesce(p_slug, '')), '') is null then raise exception 'Slug obrigatorio.'; end if;
  if p_price < 0 then raise exception 'Preco invalido.'; end if;
  if coalesce(p_supply_mode, 'stock') not in ('stock', 'made_to_order') then raise exception 'Modo de fornecimento invalido: %.', p_supply_mode; end if;

  if p_id is not null then
    select * into v_existing from public.store_items where id = p_id;
    if not found or not public.user_can_access_organization(auth.uid(), v_existing.organization_id) then raise exception 'Item da loja nao encontrado ou sem acesso.'; end if;
    v_org := v_existing.organization_id;
  else
    select * into v_event from public.events where id = p_event_id;
    if not found or not public.user_can_access_organization(auth.uid(), v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
    v_org := v_event.organization_id;
  end if;

  v_stored_event_id := case when coalesce(p_available_all_events, false) then null else p_event_id end;
  if v_stored_event_id is not null then
    select * into v_event from public.events where id = v_stored_event_id;
    if not found or v_event.organization_id <> v_org then raise exception 'Evento invalido para este item.'; end if;
  end if;

  if p_id is null then
    insert into public.store_items (organization_id, event_id, name, slug, description, image_url, price, requires_variant, is_active, sort_order, supply_mode)
    values (v_org, v_stored_event_id, trim(p_name), trim(p_slug), nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_image_url, '')), ''),
      p_price, coalesce(p_requires_variant, false), coalesce(p_is_active, true), coalesce(p_sort_order, 0), coalesce(p_supply_mode, 'stock'))
    returning id into v_id;
  else
    update public.store_items set
      organization_id = v_org, event_id = v_stored_event_id,
      name = trim(p_name), slug = trim(p_slug), description = nullif(trim(coalesce(p_description, '')), ''),
      image_url = nullif(trim(coalesce(p_image_url, '')), ''),
      price = p_price, requires_variant = coalesce(p_requires_variant, false), is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), supply_mode = coalesce(p_supply_mode, 'stock'), updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Item da loja nao encontrado.'; end if;
  end if;
  return v_id;
end; $$;

grant execute on function public.upsert_store_item(uuid, uuid, text, text, text, text, numeric, boolean, boolean, integer, text, boolean) to authenticated;

-- ============================================================
-- 4. create_store_order: aceitar itens globais (event_id nulo) na compra de
--    qualquer evento, alem dos especificos do evento da compra.
-- ============================================================

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
    select * into v_store_item from public.store_items where id = v_item.store_item_id and (event_id = p_event_id or event_id is null) and is_active;
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

commit;
