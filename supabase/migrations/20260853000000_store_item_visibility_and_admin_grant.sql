-- Camiseta extra / produto restrito: implementa o conceito de "segunda
-- camiseta" (e qualquer outro item que precise do mesmo controle) SEM criar
-- um segundo ingresso e SEM arquitetura paralela -- reaproveita
-- store_items/store_item_variants/store_item_inventory/store_orders/
-- store_order_items (loja) integralmente. Nenhuma tabela nova foi criada.
--
-- Esta migration NAO toca em: event_kit_items, event_kit_item_variants,
-- event_kit_item_variant_inventory, shirt_inventory,
-- events.limit_shirt_selection_to_stock, admin_change_ticket_shirt,
-- admin_correct_ticket_shirt_after_operation, trg_enforce_ticket_holder_
-- contact_uniqueness, ou qualquer regra de titularidade/check-in/pulseira --
-- confirmado por leitura completa de cada RPC alterada abaixo antes de
-- escrever esta migration. A camiseta principal (kit do ingresso) e a
-- camiseta extra (produto da loja) sao, a partir de agora e propositalmente,
-- DOIS sistemas de estoque distintos e nao-unificados -- unificacao fica
-- fora do escopo desta tarefa.
--
-- ============================================================
-- PARTE A -- VISIBILIDADE DO PRODUTO
-- ============================================================
-- Investigacao previa: store_items ja tem "is_active" (liga/desliga o item
-- inteiro), mas nenhum campo de visibilidade/modo de acesso. Nao existe
-- equivalente pra reaproveitar -- coluna nova e minima, 1 unica coluna:
--
--   visibility text not null default 'public'
--     check (visibility in ('public','code_required','admin_only'))
--
-- 'public': aparece no catalogo self-service (list_store_items_for_event,
--   usado tanto pela loja solo quanto pelo "compre junto" da inscricao) e
--   pode ser comprado normalmente (create_store_order/
--   add_product_to_cart_order).
-- 'code_required': reservado para quando o fluxo de codigo de acesso for
--   implementado (ver nota no fim desta migration) -- por enquanto,
--   comporta-se como admin_only (nao aparece, nao compravel self-service).
-- 'admin_only': nunca aparece no catalogo self-service; RPCs de checkout
--   self-service continuam rejeitando (defesa em profundidade -- nao
--   confiar so em "nao aparecer na lista"). Somente
--   admin_grant_store_item (Parte B) pode conceder.
--
-- Trocar de admin_only pra public e so um UPDATE nesta coluna (upsert_
-- store_item abaixo) -- nunca recria produto/variante, nunca mexe em
-- estoque ou em pedidos/concessoes ja existentes.
begin;

alter table public.store_items
  add column if not exists visibility text not null default 'public';

alter table public.store_items
  drop constraint if exists store_items_visibility_check;
alter table public.store_items
  add constraint store_items_visibility_check check (visibility in ('public','code_required','admin_only'));

-- ------------------------------------------------------------
-- list_store_items_for_event: catalogo self-service (loja solo + "compre
-- junto"). So itens 'public' aparecem aqui -- admin_only/code_required
-- ficam de fora, sem precisar de nenhuma logica extra no frontend.
-- ------------------------------------------------------------
drop function if exists public.list_store_items_for_event(uuid);

create function public.list_store_items_for_event(p_event_id uuid) returns table(
  store_item_id uuid, event_id uuid, name text, slug text, description text,
  image_url text, images jsonb,
  price numeric, requires_variant boolean, supply_mode text, sort_order integer,
  variant_id uuid, variant_name text, variant_value text, price_adjustment numeric,
  total_quantity integer, reserved_quantity integer, delivered_quantity integer, available_quantity integer
)
  language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select si.id, si.event_id, si.name, si.slug, si.description,
    (select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1),
    (select coalesce(jsonb_agg(jsonb_build_object('id', sii.id, 'url', sii.image_url, 'is_primary', sii.is_primary) order by sii.sort_order, sii.created_at), '[]'::jsonb)
       from public.store_item_images sii where sii.store_item_id = si.id),
    si.price, si.requires_variant, si.supply_mode, si.sort_order,
    siv.id, siv.name, siv.value, siv.price_adjustment,
    coalesce(inv.total_quantity, 0), coalesce(inv.reserved_quantity, 0), coalesce(inv.delivered_quantity, 0),
    case when si.supply_mode = 'made_to_order' then null
      else greatest(coalesce(inv.total_quantity, 0) - coalesce(inv.reserved_quantity, 0) - coalesce(inv.delivered_quantity, 0), 0)
    end
  from public.store_items si
  left join public.store_item_variants siv on siv.store_item_id = si.id and siv.is_active
  left join public.store_item_inventory inv on inv.store_item_id = si.id and inv.variant_id is not distinct from siv.id
  where (si.event_id = p_event_id or si.event_id is null) and si.is_active and si.visibility = 'public'
  order by si.sort_order, si.name, siv.sort_order, siv.name;
$$;

grant execute on function public.list_store_items_for_event(uuid) to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- upsert_store_item: ganha p_visibility (default 'public', preserva
-- comportamento de todo item ja cadastrado antes desta migration). Muda
-- assinatura -- precisa de drop.
-- ------------------------------------------------------------
drop function if exists public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean);

create function public.upsert_store_item(
  p_id uuid, p_event_id uuid, p_name text, p_slug text, p_description text,
  p_price numeric, p_requires_variant boolean, p_is_active boolean, p_sort_order integer,
  p_supply_mode text default 'stock', p_available_all_events boolean default false,
  p_visibility text default 'public'
) returns uuid
  language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_event public.events%rowtype; v_existing public.store_items%rowtype; v_id uuid; v_org uuid; v_stored_event_id uuid;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome obrigatorio.'; end if;
  if nullif(trim(coalesce(p_slug, '')), '') is null then raise exception 'Slug obrigatorio.'; end if;
  if p_price < 0 then raise exception 'Preco invalido.'; end if;
  if coalesce(p_supply_mode, 'stock') not in ('stock', 'made_to_order') then raise exception 'Modo de fornecimento invalido: %.', p_supply_mode; end if;
  if coalesce(p_visibility, 'public') not in ('public', 'code_required', 'admin_only') then raise exception 'Visibilidade invalida: %.', p_visibility; end if;

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
    insert into public.store_items (organization_id, event_id, name, slug, description, price, requires_variant, is_active, sort_order, supply_mode, visibility)
    values (v_org, v_stored_event_id, trim(p_name), trim(p_slug), nullif(trim(coalesce(p_description, '')), ''),
      p_price, coalesce(p_requires_variant, false), coalesce(p_is_active, true), coalesce(p_sort_order, 0), coalesce(p_supply_mode, 'stock'), coalesce(p_visibility, 'public'))
    returning id into v_id;
  else
    update public.store_items set
      organization_id = v_org, event_id = v_stored_event_id,
      name = trim(p_name), slug = trim(p_slug), description = nullif(trim(coalesce(p_description, '')), ''),
      price = p_price, requires_variant = coalesce(p_requires_variant, false), is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), supply_mode = coalesce(p_supply_mode, 'stock'), visibility = coalesce(p_visibility, 'public'), updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Item da loja nao encontrado.'; end if;
  end if;
  return v_id;
end; $$;

grant execute on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text) to authenticated, service_role;
revoke all on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text) from anon;

-- ------------------------------------------------------------
-- Defesa em profundidade: mesmo que o frontend nao mostre o item,
-- create_store_order (loja solo) e add_product_to_cart_order (compre
-- junto) sao as duas RPCs que realmente efetivam uma compra self-service --
-- as duas passam a rejeitar item que nao seja 'public', mesmo se o
-- store_item_id chegar direto (sem passar pelo catalogo filtrado).
-- ------------------------------------------------------------
create or replace function public.create_store_order("p_event_id" uuid, "p_items" jsonb, "p_payment_method" text, "p_notes" text default null) returns table(store_order_id uuid, order_number text, final_amount numeric)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
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
    if v_store_item.visibility <> 'public' then raise exception 'Item % nao esta disponivel para compra publica.', v_store_item.name; end if;
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

create or replace function public.add_product_to_cart_order(p_order_id uuid, p_store_item_id uuid, p_variant_id uuid default null, p_quantity integer default 1)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_store_item public.store_items%rowtype;
  v_variant public.store_item_variants%rowtype; v_inv public.store_item_inventory%rowtype;
  v_unit_price numeric; v_existing public.order_items%rowtype; v_item_id uuid; v_new_quantity integer;
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

  v_unit_price := v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o produto.'; end if;
    v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
  end if;

  select * into v_existing from public.order_items
    where order_id = p_order_id and item_kind = 'product' and store_item_id = v_store_item.id
      and store_item_variant_id is not distinct from p_variant_id
      and status not in ('cancelled','expired','refunded','transferred')
    for update;

  if v_store_item.supply_mode = 'stock' then
    select * into v_inv from public.store_item_inventory where store_item_id = v_store_item.id and variant_id is not distinct from p_variant_id for update;
    if not found or coalesce(v_inv.total_quantity,0) - coalesce(v_inv.reserved_quantity,0) - coalesce(v_inv.delivered_quantity,0) < p_quantity then
      raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK', detail=jsonb_build_object('code','PRODUCT_OUT_OF_STOCK','message',format('Estoque insuficiente para %s.', v_store_item.name))::text;
    end if;
    update public.store_item_inventory set reserved_quantity = reserved_quantity + p_quantity, updated_at = now() where id = v_inv.id;
  end if;

  if found and v_existing.id is not null then
    v_new_quantity := v_existing.quantity + p_quantity;
    update public.order_items
      set quantity = v_new_quantity, unit_price = v_unit_price, final_amount = round(v_unit_price * v_new_quantity, 2), updated_at = now()
      where id = v_existing.id
      returning id into v_item_id;
  else
    insert into public.order_items(order_id, event_id, item_kind, store_item_id, store_item_variant_id, quantity, unit_price, discount_amount, final_amount, status, ownership_status)
    values(p_order_id, v_order.event_id, 'product', v_store_item.id, p_variant_id, p_quantity, v_unit_price, 0, round(v_unit_price * p_quantity, 2), 'reserved', 'unassigned')
    returning id into v_item_id;
  end if;

  perform public.apply_cart_coupon(p_order_id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_added', 'orders', p_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'store_item_id', v_store_item.id, 'variant_id', p_variant_id, 'quantity_added', p_quantity, 'order_item_id', v_item_id));

  return jsonb_build_object('order_item_ids', array[v_item_id], 'unit_price', v_unit_price);
end; $$;

-- ============================================================
-- PARTE B -- CONCESSAO MANUAL PELO ADMIN (sem criar segundo ingresso)
-- ============================================================
-- Reaproveita 100% a arquitetura de pedidos da loja: a concessao e um
-- store_orders + store_order_items normal, so que criado pelo admin em nome
-- do participante/ingresso (nunca pelo proprio comprador) e marcado com
-- payment_method='admin_courtesy'/'admin_charge' pra ficar rastreavel como
-- origem administrativa. Nao existe nenhuma tabela nova.
--
-- Cortesia: final_amount = 0 (no pedido inteiro e no item), pedido nasce ja
-- 'confirmed'/'paid' -- nao gera valor a receber, mas o pedido/item continua
-- existindo e rastreavel (nunca um "presente invisivel" fora do sistema).
-- Cobrar: usa o preco normal do item/variante, pedido nasce 'pending' --
-- reaproveita o MESMO fluxo financeiro ja existente da loja
-- (confirm_store_order_payment, ja usado pelo admin em /loja) pra dar baixa
-- no pagamento depois. Nenhum sistema financeiro paralelo foi criado.
--
-- Estoque: mesmo gate de create_store_order (reserva so quando supply_mode
-- ='stock', respeitando o "somente se tiver estoque" ja adotado pela loja).
-- admin_only NUNCA significa estoque ilimitado.
--
-- Vinculo ao ingresso: store_orders.participant_id (coluna ja existente,
-- nunca usada por concessao administrativa ate agora) recebe o participante
-- resolvido do ticket (order_item.participant_id, com fallback pro
-- participant_id direto do ticket) -- mesmo padrao ja usado por
-- admin_change_ticket_shirt pra resolver titular. store_orders.user_id
-- recebe o comprador do pedido do ingresso (orders.user_id), nunca o admin
-- que esta operando -- o pedido continua sendo "do" participante/comprador,
-- so que criado administrativamente.
-- ============================================================

create or replace function public.admin_grant_store_item(
  p_ticket_id uuid, p_store_item_id uuid, p_variant_id uuid, p_quantity integer,
  p_is_courtesy boolean, p_reason text default null
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_order public.orders%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype; v_inv public.store_item_inventory%rowtype;
  v_participant_id uuid; v_unit_price numeric; v_line_total numeric; v_order_id uuid; v_order_number text; v_item_id uuid;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if v_actor is null or not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para conceder itens da loja.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into v_oi from public.order_items where id = v_ticket.order_item_id;
  v_participant_id := coalesce(v_oi.participant_id, v_ticket.participant_id);
  select * into strict v_order from public.orders where id = v_ticket.order_id;

  select * into v_store_item from public.store_items where id = p_store_item_id
    and (event_id = v_ticket.event_id or event_id is null) and is_active and organization_id = v_ticket.organization_id;
  if not found then raise exception 'Item da loja indisponivel para este evento.'; end if;
  if v_store_item.requires_variant and p_variant_id is null then raise exception 'Item exige selecao de variante.'; end if;

  v_unit_price := v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o item.'; end if;
    v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
  end if;

  if v_store_item.supply_mode = 'stock' then
    select * into v_inv from public.store_item_inventory where store_item_id = v_store_item.id and variant_id is not distinct from p_variant_id for update;
    if not found or coalesce(v_inv.total_quantity,0) - coalesce(v_inv.reserved_quantity,0) - coalesce(v_inv.delivered_quantity,0) < p_quantity then
      raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK', detail=jsonb_build_object('code','PRODUCT_OUT_OF_STOCK','message',format('Estoque insuficiente para %s.', v_store_item.name))::text;
    end if;
    update public.store_item_inventory set reserved_quantity = reserved_quantity + p_quantity, updated_at = now() where id = v_inv.id;
  end if;

  v_line_total := case when coalesce(p_is_courtesy, false) then 0 else round(v_unit_price * p_quantity, 2) end;
  v_order_number := 'ADMIN-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.store_orders (organization_id, event_id, user_id, participant_id, order_number, status, payment_method, payment_status, base_amount, final_amount, notes, confirmed_at)
  values (v_ticket.organization_id, v_ticket.event_id, v_order.user_id, v_participant_id, v_order_number,
    case when coalesce(p_is_courtesy, false) then 'confirmed' else 'pending' end,
    case when coalesce(p_is_courtesy, false) then 'admin_courtesy' else 'admin_charge' end,
    case when coalesce(p_is_courtesy, false) then 'paid' else 'pending' end,
    v_line_total, v_line_total,
    nullif(trim(coalesce(p_reason, '')), ''), case when coalesce(p_is_courtesy, false) then now() end)
  returning id into v_order_id;

  insert into public.store_order_items (store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status)
  values (v_order_id, v_store_item.id, p_variant_id, p_quantity,
    case when coalesce(p_is_courtesy, false) then 0 else v_unit_price end, v_line_total,
    case when coalesce(p_is_courtesy, false) then 'confirmed' else 'reserved' end)
  returning id into v_item_id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_item_admin_granted', 'store_order_items', v_item_id, v_ticket.event_id,
    jsonb_build_object('actor_user_id', v_actor, 'actor_email', v_actor_email, 'ticket_id', v_ticket.id, 'participant_id', v_participant_id,
      'store_order_id', v_order_id, 'store_item_id', v_store_item.id, 'store_item_name', v_store_item.name,
      'variant_id', p_variant_id, 'quantity', p_quantity, 'is_courtesy', coalesce(p_is_courtesy, false), 'unit_price', v_unit_price,
      'final_amount', v_line_total, 'origin', 'admin', 'reason', nullif(trim(coalesce(p_reason,'')),'')));

  return v_item_id;
end; $$;

revoke all on function public.admin_grant_store_item(uuid, uuid, uuid, integer, boolean, text) from public, anon;
grant execute on function public.admin_grant_store_item(uuid, uuid, uuid, integer, boolean, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- deliver_store_order_item: correcao de robustez (vale pra loja inteira, nao
-- so pra concessao administrativa) -- antes desta migration a entrega
-- nunca reconferia disponibilidade fisica no momento da entrega, so confiava
-- na reserva feita na hora da compra/concessao. Isso e seguro no caminho
-- feliz (reserved+delivered<=total sempre valeu desde a reserva), mas nao
-- protege contra estoque reduzido manualmente DEPOIS da reserva (ex.: admin
-- corrige a contagem fisica pra um numero menor que o ja reservado). Estoque
-- 0 (ou insuficiente) agora SEMPRE bloqueia a entrega, com o mesmo padrao de
-- erro estruturado ja usado no restante do sistema -- item continua
-- 'confirmed' (nao muda de status), nada e decrementado.
-- ------------------------------------------------------------
create or replace function public.deliver_store_order_item(p_store_order_item_id uuid) returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype; v_item public.store_items%rowtype; v_inv public.store_item_inventory%rowtype; v_available integer;
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
    select * into v_inv from public.store_item_inventory where store_item_id = v_line.store_item_id and variant_id is not distinct from v_line.variant_id for update;
    v_available := case when found then greatest(v_inv.total_quantity - v_inv.delivered_quantity, 0) else 0 end;
    if v_inv.id is null or v_available < v_line.quantity then
      raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK', detail=jsonb_build_object('code','PRODUCT_OUT_OF_STOCK','message',format('Estoque insuficiente para %s. A entrega nao foi confirmada.', v_item.name))::text;
    end if;
    update public.store_item_inventory set reserved_quantity = greatest(reserved_quantity - v_line.quantity, 0),
      delivered_quantity = delivered_quantity + v_line.quantity, updated_at = now()
    where id = v_inv.id;
  end if;
  update public.store_order_items set status = 'delivered', delivered_at = now() where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivered', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object('actor_user_id', auth.uid()));
  return true;
end; $$;

commit;

-- ============================================================
-- NOTA -- CODE_REQUIRED (Parte C): implementado apenas como VALOR VALIDO da
-- coluna visibility (admin ja pode marcar um produto como code_required),
-- mas o fluxo de liberacao por codigo NAO foi construido nesta migration.
--
-- Investigacao confirmou que o sistema de cupons (public.coupons) e
-- estritamente de DESCONTO: coupons_applies_to_something_check exige
-- applies_to_tickets/applies_to_products, todo o motor de aplicacao
-- (apply_cart_coupon/is_order_item_eligible_for_coupon) assume um item JA
-- visivel/adicionavel ao carrinho e so calcula discount_amount sobre ele --
-- nunca e consultado ANTES de um item poder ser adicionado. Forcar
-- "code_required" dentro de coupons exigiria ou (a) inventar um desconto de
-- 0% so pra usar o cupom como flag de liberacao -- gambiarra que mistura
-- desconto com controle de acesso, contrariando o pedido explicito -- ou
-- (b) reescrever add_product_to_cart_order/create_store_order pra aceitar
-- um "codigo" que nao e cupom, quebrando a garantia hoje testada de que
-- todo cupom sempre produz um discount_amount>=0 rastreavel em
-- order_item_discounts.
--
-- Caminho recomendado quando for priorizado: tabela dedicada (ex.:
-- store_item_access_codes: id, store_item_id, code, max_uses, used_count,
-- valid_from, valid_until, is_active) + RPC redeem_store_item_access_code
-- (p_store_item_id, p_code) que so retorna/gera uma autorizacao temporaria
-- (ex.: registra em uma tabela ou retorna um token curto) permitindo aquele
-- p_store_item_id especifico entrar em add_product_to_cart_order/
-- create_store_order MESMO com visibility='code_required' -- sem tocar em
-- coupons nem em desconto. Ate isso existir, um item marcado como
-- code_required se comporta exatamente como admin_only (nao aparece,
-- nao compravel self-service, so concedivel via admin_grant_store_item).
-- ============================================================
