-- Corrige o bug relatado: um produto GLOBAL da loja ("Todos os eventos" --
-- store_items.event_id IS NULL, visibility='public', is_active=true) nao
-- aparecia em /minha-conta/loja para um usuario sem nenhum ingresso, e nem
-- podia ser comprado por ele.
--
-- AUDITORIA (causa raiz completa, camada por camada):
--
-- 1) /minha-conta/loja/page.tsx fechava a pagina inteira com o estado vazio
--    "Nenhum evento disponivel" sempre que o usuario nao tinha nenhum evento
--    (ownedEventIds vazio), ANTES de sequer tentar carregar produtos --
--    corrigido separadamente no codigo (nao e responsabilidade desta
--    migration).
-- 2) Mesmo corrigindo (1), getStoreItemsForEvents(supabase, []) nunca
--    chamaria a RPC list_store_items_for_event (ela mapeia 1 chamada por
--    evento; lista vazia = zero chamadas) -- tambem corrigido no codigo,
--    chamando a RPC com p_event_id=null (a propria RPC ja retorna soh os
--    itens globais nesse caso: `where (si.event_id = p_event_id or
--    si.event_id is null)` vira so `si.event_id is null` quando
--    p_event_id e null).
-- 3) MESMO corrigindo (1) e (2), a compra em si travava: store_orders.event_id
--    e NOT NULL desde o schema base, e a RPC create_store_order sempre
--    exigia um p_event_id valido (`select ... from events where id =
--    p_event_id; if not found then raise exception 'Evento invalido.'`) --
--    ou seja, um pedido sem nenhum evento associado JAMAIS poderia ser
--    criado, mesmo que fosse 100% composto por produtos globais.
--
-- Esta migration ataca (3), a causa raiz no banco:
--   a) store_orders.event_id passa a aceitar NULL (pedido "sem evento",
--      exclusivamente para carrinhos 100% compostos por produtos globais).
--   b) trg_store_orders_set_org (resolve organization_id a partir do
--      evento) e reescrito para nao explodir quando NEW.event_id e null --
--      espelha exatamente o mesmo padrao que trg_store_items_set_org ja usa
--      pra store_items.event_id null (mesmo arquivo/tabela irma): quando
--      nao ha evento, organization_id tem que vir explicito no INSERT.
--   c) create_store_order aceita p_event_id null: nesse modo, resolve
--      organization_id a partir dos proprios store_items do carrinho (todos
--      tem que pertencer a mesma organizacao) e so aceita itens
--      store_items.event_id IS NULL -- um pedido sem evento jamais pode
--      conter um item vinculado a um evento especifico. O caminho com
--      p_event_id preenchido continua BYTE A BYTE identico ao anterior (0
--      risco de regressao pra compras normais vinculadas a evento).
--
-- O que NAO muda: reserve_store_item_stock/store_item_inventory (estoque
-- proprio do produto, por store_item_id+variant_id) ja e completamente
-- independente de evento -- nao ha nada a ajustar ali; um produto global
-- sem linked_event_kit_item_id sempre usou (e continua usando) seu proprio
-- estoque em store_item_inventory, nunca o do kit.
begin;

alter table public.store_orders
  alter column event_id drop not null;

create or replace function public.trg_store_orders_set_org()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_org uuid;
begin
  if NEW.event_id is not null then
    select organization_id into v_org from public.events where id = NEW.event_id;
    if not found or v_org is null then raise exception 'Evento % nao encontrado ou sem organization_id.', NEW.event_id; end if;
    if NEW.organization_id is not null and NEW.organization_id <> v_org then raise exception 'organization_id divergente em store_orders (esperado %).', v_org; end if;
    NEW.organization_id := v_org;
  elsif NEW.organization_id is null then
    raise exception 'organization_id obrigatorio para pedido sem evento (produto global).';
  end if;
  return NEW;
end; $$;

create or replace function public.create_store_order(p_event_id uuid, p_items jsonb, p_payment_method text, p_notes text default null)
returns table(store_order_id uuid, order_number text, final_amount numeric)
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_actor uuid := auth.uid(); v_event public.events%rowtype; v_order_id uuid; v_order_number text;
  v_item record; v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_unit_price numeric; v_final_unit_price numeric; v_line_total numeric; v_total numeric := 0; v_paid boolean; v_participant_id uuid;
  v_organization_id uuid;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Nenhum item selecionado.'; end if;

  if p_event_id is not null then
    select * into v_event from public.events where id = p_event_id;
    if not found then raise exception 'Evento invalido.'; end if;
    select id into v_participant_id from public.participants where user_id = v_actor and event_id = p_event_id order by created_at desc limit 1;
  else
    -- Pedido sem evento: so pode conter produtos globais (event_id IS NULL),
    -- e todos precisam pertencer a mesma organizacao (organization_id do
    -- pedido vem daqui, ja que nao ha evento pra resolve-lo).
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
    insert into public.store_order_items (store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status, discount_type, discount_value, final_unit_price)
    values (v_order_id, v_store_item.id, v_item.variant_id, v_item.quantity, v_unit_price, v_line_total, case when v_paid then 'confirmed' else 'reserved' end,
      v_store_item.discount_type, v_store_item.discount_value, v_final_unit_price);
  end loop;

  update public.store_orders set base_amount = v_total, final_amount = v_total, updated_at = now() where id = v_order_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_created', 'store_orders', v_order_id, p_event_id, jsonb_build_object('actor_user_id', v_actor, 'final_amount', v_total, 'payment_method', p_payment_method));

  return query select v_order_id, v_order_number, v_total;
end; $$;

commit;
