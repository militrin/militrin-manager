-- Corrige dois pontos da Loja identificados apos a migration 53:
--
-- 1) "Novo item" desaparecia com o filtro em "Todos os eventos" -- bug de
--    UI (page.tsx so renderizava o form quando havia um evento selecionado).
--    store_items.event_id ja era nullable e ja significava "disponivel pra
--    todos os eventos" (nenhum campo novo necessario aqui) -- so faltava a
--    RPC upsert_store_item saber resolver a organizacao quando p_event_id
--    vem nulo (hoje ela SEMPRE exige um evento pra descobrir a organizacao,
--    mesmo pra criar um item global).
--
-- 2) Camiseta extra vinculada a um evento (ex.: "Camiseta Militrin 2026")
--    nao pode ter estoque duplicado em relacao a camiseta do kit do mesmo
--    evento -- isso permitiria vender/entregar unidades que nao existem.
--    Investigacao confirmou: store_order_items.variant_id e
--    store_item_inventory.variant_id tem FK NOT NULL-compativel apontando
--    para store_item_variants(id) -- ou seja, e IMPOSSIVEL gravar
--    diretamente um id de event_kit_item_variants em store_order_items sem
--    violar a FK. A solucao minima e uma linha "espelho" (ponteiro) em
--    store_item_variants que aponta pro event_kit_item_variants real, com
--    NENHUMA linha em store_item_inventory para essa variante -- os NUMEROS
--    (total/reserved/delivered) moram SEMPRE em event_kit_item_variant_
--    inventory quando o item esta vinculado. Nunca ha copia sincronizada de
--    quantidade -- so identidade (nome/tamanho) e sincronizada, e so na
--    hora de vincular ou quando o admin pede sincronizar de novo.
--
-- MODELAGEM ESCOLHIDA (minima, reaproveitando o que ja existe):
--   store_items.linked_event_kit_item_id uuid null references
--     event_kit_items(id) -- quando setado, o item usa o estoque
--     compartilhado do evento. Nulo = item independente da loja (like antes
--     desta migration).
--   store_item_variants.linked_event_kit_item_variant_id uuid null
--     references event_kit_item_variants(id) -- a linha "espelho" por
--     tamanho. Sem essa referencia = variante normal da loja.
--   Nao foi criado um campo "inventory_source" separado (stock/event_kit):
--     a propria presenca/ausencia dessas 2 referencias ja determina a fonte
--     de estoque de forma inequivoca, sem precisar manter 2 campos em
--     sincronia entre si.
--
-- Toda a logica de reserva/entrega/liberacao/desfazer passa a rodar por 4
-- funcoes auxiliares centralizadas (reserve_store_item_stock,
-- deliver_store_item_stock, release_store_item_reservation,
-- undo_deliver_store_item_stock) que decidem sozinhas qual tabela de
-- estoque usar -- as 6 RPCs que hoje mexem em estoque da loja
-- (create_store_order, add_product_to_cart_order, deliver_store_order_item,
-- admin_grant_store_item, cancel_store_order, undo_store_order_item_
-- delivery) so PASSAM A CHAMAR essas 4 funcoes em vez de fazer UPDATE
-- direto -- isso concentra a garantia de atomicidade/anti-overselling num
-- unico lugar em vez de duplicar a logica em 6 RPCs diferentes.
--
-- NAO ALTERADO por esta migration: regras de camiseta principal (migration
-- 52), regras de titularidade/check-in/pulseira, gateway de pagamento,
-- arquitetura geral de pedidos. Nenhuma tabela nova foi criada -- so 2
-- colunas em tabelas ja existentes da loja.
begin;

-- ============================================================
-- 1) Colunas de vinculo (minimas, nada duplicado)
-- ============================================================

alter table public.store_items
  add column if not exists linked_event_kit_item_id uuid references public.event_kit_items(id);

alter table public.store_item_variants
  add column if not exists linked_event_kit_item_variant_id uuid references public.event_kit_item_variants(id);

-- Nunca 2 variantes-espelho do mesmo item de loja apontando pro mesmo
-- tamanho de kit -- protege contra bug de sincronizacao duplicando linhas.
create unique index if not exists ux_store_item_variants_linked_kit_variant
  on public.store_item_variants (store_item_id, linked_event_kit_item_variant_id)
  where linked_event_kit_item_variant_id is not null;

-- ============================================================
-- 2) Funcoes auxiliares centralizadas de estoque -- unica fonte de verdade
--    por chamada, decide sozinha se usa event_kit_item_variant_inventory
--    (item vinculado) ou store_item_inventory (item independente).
-- ============================================================

-- Reserva (compra self-service ou concessao administrativa). So bloqueia a
-- ESCOLHA quando ha controle de estoque ativo: para item vinculado, isso e
-- eki.shirt_supply_mode='stock' -- a MESMA config B ja definida pra
-- camiseta principal na migration 52 (item vinculado nunca tem config
-- propria: "e a mesma camiseta", entao usa a mesma regra). Para item
-- independente, e supply_mode='stock' da propria store_items, como ja
-- funcionava antes.
create or replace function public.reserve_store_item_stock(p_store_item_id uuid, p_variant_id uuid, p_quantity integer)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_kit_item public.event_kit_items%rowtype; v_kit_inv public.event_kit_item_variant_inventory%rowtype;
  v_store_inv public.store_item_inventory%rowtype; v_available integer;
begin
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found then raise exception 'Item da loja nao encontrado.'; end if;

  if v_item.linked_event_kit_item_id is not null then
    if p_variant_id is null then raise exception 'Este item usa o estoque do evento e exige selecao de tamanho.'; end if;
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = p_store_item_id;
    if not found or v_variant.linked_event_kit_item_variant_id is null then raise exception 'Variante invalida para este item vinculado ao evento.'; end if;
    select * into v_kit_item from public.event_kit_items where id = v_item.linked_event_kit_item_id;

    if coalesce(v_kit_item.shirt_supply_mode, 'stock') = 'stock' then
      select * into v_kit_inv from public.event_kit_item_variant_inventory
        where kit_item_id = v_kit_item.id and variant_id = v_variant.linked_event_kit_item_variant_id for update;
      if not found then raise exception 'Estoque do evento nao configurado para este tamanho.'; end if;
      v_available := greatest(coalesce(v_kit_inv.total_quantity,0) - coalesce(v_kit_inv.reserved_quantity,0) - coalesce(v_kit_inv.delivered_quantity,0), 0);
      if v_available < p_quantity then
        raise exception using errcode='P0001', message='STORE_ITEM_OUT_OF_STOCK',
          detail=jsonb_build_object('code','STORE_ITEM_OUT_OF_STOCK','message',format('Estoque insuficiente para %s.', v_item.name))::text;
      end if;
      update public.event_kit_item_variant_inventory set reserved_quantity = reserved_quantity + p_quantity, updated_at = now() where id = v_kit_inv.id;
    end if;
    -- made_to_order (config B desligada no item do evento): escolha sempre
    -- permitida, igual a regra da camiseta principal -- a entrega e que
    -- continua bloqueando em zero (ver deliver_store_item_stock).
    return;
  end if;

  if v_item.supply_mode = 'stock' then
    select * into v_store_inv from public.store_item_inventory where store_item_id = p_store_item_id and variant_id is not distinct from p_variant_id for update;
    if not found or coalesce(v_store_inv.total_quantity,0) - coalesce(v_store_inv.reserved_quantity,0) - coalesce(v_store_inv.delivered_quantity,0) < p_quantity then
      raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK', detail=jsonb_build_object('code','PRODUCT_OUT_OF_STOCK','message',format('Estoque insuficiente para %s.', v_item.name))::text;
    end if;
    update public.store_item_inventory set reserved_quantity = reserved_quantity + p_quantity, updated_at = now() where id = v_store_inv.id;
  end if;
end; $$;

revoke all on function public.reserve_store_item_stock(uuid, uuid, integer) from public, anon;
grant execute on function public.reserve_store_item_stock(uuid, uuid, integer) to authenticated, service_role;

-- Entrega fisica: estoque insuficiente SEMPRE bloqueia, nos dois modos --
-- mesma regra definitiva da entrega de camiseta principal (migration 52),
-- reaproveitada aqui em vez de reimplementada.
create or replace function public.deliver_store_item_stock(p_store_item_id uuid, p_variant_id uuid, p_quantity integer)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_kit_item public.event_kit_items%rowtype; v_kit_inv public.event_kit_item_variant_inventory%rowtype;
  v_store_inv public.store_item_inventory%rowtype; v_available integer;
begin
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found then raise exception 'Item da loja nao encontrado.'; end if;

  if v_item.linked_event_kit_item_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = p_store_item_id;
    if not found or v_variant.linked_event_kit_item_variant_id is null then raise exception 'Variante invalida para este item vinculado ao evento.'; end if;
    select * into v_kit_item from public.event_kit_items where id = v_item.linked_event_kit_item_id;

    select * into v_kit_inv from public.event_kit_item_variant_inventory
      where kit_item_id = v_kit_item.id and variant_id = v_variant.linked_event_kit_item_variant_id for update;
    v_available := case when found then greatest(v_kit_inv.total_quantity - v_kit_inv.delivered_quantity, 0) else 0 end;
    if v_kit_inv.id is null or v_available < p_quantity then
      raise exception using errcode='P0001', message='STORE_ITEM_OUT_OF_STOCK',
        detail=jsonb_build_object('code','STORE_ITEM_OUT_OF_STOCK','message',format('Estoque insuficiente para %s. A entrega nao foi confirmada.', v_item.name))::text;
    end if;
    update public.event_kit_item_variant_inventory
      set reserved_quantity = greatest(reserved_quantity - p_quantity, 0), delivered_quantity = delivered_quantity + p_quantity, updated_at = now()
      where id = v_kit_inv.id;
    return;
  end if;

  if v_item.supply_mode = 'stock' then
    select * into v_store_inv from public.store_item_inventory where store_item_id = p_store_item_id and variant_id is not distinct from p_variant_id for update;
    v_available := case when found then greatest(v_store_inv.total_quantity - v_store_inv.delivered_quantity, 0) else 0 end;
    if v_store_inv.id is null or v_available < p_quantity then
      raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK', detail=jsonb_build_object('code','PRODUCT_OUT_OF_STOCK','message',format('Estoque insuficiente para %s. A entrega nao foi confirmada.', v_item.name))::text;
    end if;
    update public.store_item_inventory
      set reserved_quantity = greatest(reserved_quantity - p_quantity, 0), delivered_quantity = delivered_quantity + p_quantity, updated_at = now()
      where id = v_store_inv.id;
  end if;
end; $$;

revoke all on function public.deliver_store_item_stock(uuid, uuid, integer) from public, anon;
grant execute on function public.deliver_store_item_stock(uuid, uuid, integer) to authenticated, service_role;

-- Libera reserva sem entregar (cancelamento). "not found"/linha ausente
-- nunca bloqueia o cancelamento -- so nao ha nada pra liberar.
create or replace function public.release_store_item_reservation(p_store_item_id uuid, p_variant_id uuid, p_quantity integer)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype; v_kit_item public.event_kit_items%rowtype;
begin
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found then return; end if;

  if v_item.linked_event_kit_item_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = p_store_item_id;
    if not found or v_variant.linked_event_kit_item_variant_id is null then return; end if;
    update public.event_kit_item_variant_inventory set reserved_quantity = greatest(reserved_quantity - p_quantity, 0), updated_at = now()
      where kit_item_id = v_item.linked_event_kit_item_id and variant_id = v_variant.linked_event_kit_item_variant_id;
    return;
  end if;

  update public.store_item_inventory set reserved_quantity = greatest(reserved_quantity - p_quantity, 0), updated_at = now()
    where store_item_id = p_store_item_id and variant_id is not distinct from p_variant_id;
end; $$;

revoke all on function public.release_store_item_reservation(uuid, uuid, integer) from public, anon;
grant execute on function public.release_store_item_reservation(uuid, uuid, integer) to authenticated, service_role;

-- Desfaz entrega (delivered -> reserved de novo).
create or replace function public.undo_deliver_store_item_stock(p_store_item_id uuid, p_variant_id uuid, p_quantity integer)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
begin
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found then return; end if;

  if v_item.linked_event_kit_item_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = p_store_item_id;
    if not found or v_variant.linked_event_kit_item_variant_id is null then return; end if;
    update public.event_kit_item_variant_inventory
      set delivered_quantity = greatest(delivered_quantity - p_quantity, 0), reserved_quantity = reserved_quantity + p_quantity, updated_at = now()
      where kit_item_id = v_item.linked_event_kit_item_id and variant_id = v_variant.linked_event_kit_item_variant_id;
    return;
  end if;

  update public.store_item_inventory
    set delivered_quantity = greatest(delivered_quantity - p_quantity, 0), reserved_quantity = reserved_quantity + p_quantity, updated_at = now()
    where store_item_id = p_store_item_id and variant_id is not distinct from p_variant_id;
end; $$;

revoke all on function public.undo_deliver_store_item_stock(uuid, uuid, integer) from public, anon;
grant execute on function public.undo_deliver_store_item_stock(uuid, uuid, integer) to authenticated, service_role;

-- ============================================================
-- 3) sync_linked_store_item_variants -- materializa/atualiza as linhas
--    "espelho" em store_item_variants a partir das variantes ATIVAS do
--    item de kit vinculado. So sincroniza IDENTIDADE (nome/tamanho) --
--    NUNCA quantidade (isso nunca existe em store_item_inventory pra essas
--    variantes). Variante removida/desativada no evento vira is_active=
--    false aqui tambem (nunca deletada, pra preservar pedidos ja feitos).
-- ============================================================
create or replace function public.sync_linked_store_item_variants(p_store_item_id uuid)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_item public.store_items%rowtype; v_kit_variant record;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_item.organization_id) then raise exception 'Item da loja nao encontrado ou sem acesso.'; end if;
  if v_item.linked_event_kit_item_id is null then raise exception 'Este item nao esta vinculado a um item de kit de evento.'; end if;

  for v_kit_variant in
    select id, name, value, sort_order from public.event_kit_item_variants
    where kit_item_id = v_item.linked_event_kit_item_id and is_active
  loop
    insert into public.store_item_variants (store_item_id, name, value, price_adjustment, is_active, sort_order, linked_event_kit_item_variant_id)
    values (p_store_item_id, v_kit_variant.name, v_kit_variant.value, 0, true, v_kit_variant.sort_order, v_kit_variant.id)
    on conflict (store_item_id, linked_event_kit_item_variant_id) where linked_event_kit_item_variant_id is not null
    do update set name = excluded.name, value = excluded.value, sort_order = excluded.sort_order, is_active = true;
  end loop;

  update public.store_item_variants set is_active = false
  where store_item_id = p_store_item_id and linked_event_kit_item_variant_id is not null
    and linked_event_kit_item_variant_id not in (
      select id from public.event_kit_item_variants where kit_item_id = v_item.linked_event_kit_item_id and is_active
    );
end; $$;

revoke all on function public.sync_linked_store_item_variants(uuid) from public, anon;
grant execute on function public.sync_linked_store_item_variants(uuid) to authenticated, service_role;

-- ============================================================
-- 4) upsert_store_item -- resolve organizacao via current_organization_id()
--    quando p_event_id vem nulo (corrige o bug de "Novo item" em "Todos os
--    eventos"); ganha p_linked_event_kit_item_id (link opcional); forca
--    requires_variant=true e event_id=evento do kit quando vinculado
--    (a camiseta vinculada e sempre daquele evento especifico, nunca
--    "todos os eventos"); dispara a sincronizacao das variantes-espelho
--    quando o vinculo e criado ou trocado.
-- ============================================================
drop function if exists public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text);

create function public.upsert_store_item(
  p_id uuid, p_event_id uuid, p_name text, p_slug text, p_description text,
  p_price numeric, p_requires_variant boolean, p_is_active boolean, p_sort_order integer,
  p_supply_mode text default 'stock', p_available_all_events boolean default false,
  p_visibility text default 'public', p_linked_event_kit_item_id uuid default null
) returns uuid
  language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_event public.events%rowtype; v_existing public.store_items%rowtype; v_id uuid; v_org uuid; v_stored_event_id uuid;
  v_kit_item public.event_kit_items%rowtype; v_requires_variant boolean; v_previous_link uuid;
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
    v_previous_link := v_existing.linked_event_kit_item_id;
  elsif p_event_id is not null then
    select * into v_event from public.events where id = p_event_id;
    if not found or not public.user_can_access_organization(auth.uid(), v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
    v_org := v_event.organization_id;
  else
    -- Criacao de item GLOBAL (sem evento -- filtro "Todos os eventos"):
    -- resolve a organizacao do proprio usuario, mesmo mecanismo ja usado
    -- por create_event pra criar um evento novo sem contexto previo.
    v_org := public.current_organization_id();
    if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then raise exception 'Nao foi possivel identificar a organizacao do usuario.'; end if;
  end if;

  v_requires_variant := coalesce(p_requires_variant, false);

  if p_linked_event_kit_item_id is not null then
    select * into v_kit_item from public.event_kit_items where id = p_linked_event_kit_item_id;
    if not found then raise exception 'Item de kit invalido para vincular.'; end if;
    select organization_id into v_org from public.events where id = v_kit_item.event_id;
    if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
      raise exception 'Item de kit invalido ou sem acesso.';
    end if;
    -- Camiseta vinculada e sempre do evento especifico do kit -- nunca
    -- "todos os eventos" (nao faria sentido: o estoque compartilhado e
    -- por natureza daquele evento). A organizacao do item passa a ser a
    -- do evento do kit, sempre -- nunca a resolvida antes (p_id/p_event_id/
    -- current_organization_id()), que so serve pra validar acesso ate aqui.
    v_stored_event_id := v_kit_item.event_id;
    v_requires_variant := true;

    -- Troca "estoque proprio" -> "camiseta do evento" NUNCA migra/funde
    -- estoque automaticamente -- se o item ja tem quantidade, reserva ou
    -- entrega configurada no estoque proprio, bloqueia com erro explicito
    -- em vez de vincular silenciosamente (evitaria perda de referencia).
    if p_id is not null and v_previous_link is null and exists (
      select 1 from public.store_item_inventory
      where store_item_id = p_id and (total_quantity > 0 or reserved_quantity > 0 or delivered_quantity > 0)
    ) then
      raise exception 'Este item ja possui estoque proprio configurado (quantidade, reserva ou entrega). Nao e possivel vincular automaticamente ao estoque de um evento -- zere o estoque proprio primeiro ou cadastre um novo produto vinculado.';
    end if;

    -- Trocar o vinculo pra um item de kit DIFERENTE do que ja estava
    -- vinculado tambem nunca migra pedidos ja feitos -- bloqueia se ha
    -- pedido/concessao nao cancelado apontando pras variantes-espelho
    -- atuais (ficariam referenciando um estoque que nao e mais o vinculado).
    if p_id is not null and v_previous_link is not null and p_linked_event_kit_item_id is distinct from v_previous_link and exists (
      select 1 from public.store_order_items soi join public.store_item_variants siv on siv.id = soi.variant_id
      where soi.store_item_id = p_id and siv.linked_event_kit_item_variant_id is not null and soi.status <> 'cancelled'
    ) then
      raise exception 'Este item ja possui pedidos ou concessoes usando o vinculo atual. Nao e possivel trocar o item de kit vinculado automaticamente -- cadastre um novo produto para o novo vinculo.';
    end if;
  else
    -- Desvincular ("camiseta do evento" -> "estoque proprio") tambem nunca
    -- migra automaticamente -- bloqueia se ha pedido/concessao nao
    -- cancelado usando o vinculo atual (ficariam sem fonte de estoque).
    if p_id is not null and v_previous_link is not null and exists (
      select 1 from public.store_order_items soi join public.store_item_variants siv on siv.id = soi.variant_id
      where soi.store_item_id = p_id and siv.linked_event_kit_item_variant_id is not null and soi.status <> 'cancelled'
    ) then
      raise exception 'Este item ja possui pedidos ou concessoes usando o estoque compartilhado do evento. Nao e possivel desvincular automaticamente -- cadastre um novo produto para estoque proprio, se necessario.';
    end if;
    -- p_event_id nulo (criacao global, filtro "Todos os eventos") ou
    -- p_available_all_events=true resultam no mesmo estado: event_id nulo
    -- em store_items, que ja significa "disponivel pra todos os eventos".
    v_stored_event_id := case when coalesce(p_available_all_events, false) then null else p_event_id end;
    if v_stored_event_id is not null then
      select * into v_event from public.events where id = v_stored_event_id;
      if not found or v_event.organization_id <> v_org then raise exception 'Evento invalido para este item.'; end if;
    end if;
  end if;

  if p_id is null then
    insert into public.store_items (organization_id, event_id, name, slug, description, price, requires_variant, is_active, sort_order, supply_mode, visibility, linked_event_kit_item_id)
    values (v_org, v_stored_event_id, trim(p_name), trim(p_slug), nullif(trim(coalesce(p_description, '')), ''),
      p_price, v_requires_variant, coalesce(p_is_active, true), coalesce(p_sort_order, 0), coalesce(p_supply_mode, 'stock'), coalesce(p_visibility, 'public'), p_linked_event_kit_item_id)
    returning id into v_id;
  else
    update public.store_items set
      organization_id = v_org, event_id = v_stored_event_id,
      name = trim(p_name), slug = trim(p_slug), description = nullif(trim(coalesce(p_description, '')), ''),
      price = p_price, requires_variant = v_requires_variant, is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), supply_mode = coalesce(p_supply_mode, 'stock'), visibility = coalesce(p_visibility, 'public'),
      linked_event_kit_item_id = p_linked_event_kit_item_id, updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Item da loja nao encontrado.'; end if;
  end if;

  if p_linked_event_kit_item_id is not null and p_linked_event_kit_item_id is distinct from v_previous_link then
    perform public.sync_linked_store_item_variants(v_id);
  end if;

  return v_id;
end; $$;

grant execute on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text, uuid) to authenticated, service_role;
revoke all on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text, uuid) from anon;

-- ============================================================
-- 5) upsert_store_item_variant / set_store_item_stock -- bloqueiam edicao
--    manual quando o alvo e um item/variante vinculado ao evento. Tamanho e
--    estoque desses vem exclusivamente do item de kit do evento.
-- ============================================================
create or replace function public.upsert_store_item_variant("p_id" uuid, "p_store_item_id" uuid, "p_name" text, "p_value" text, "p_price_adjustment" numeric, "p_is_active" boolean, "p_sort_order" integer) returns uuid
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_item public.store_items%rowtype; v_id uuid; v_existing_variant public.store_item_variants%rowtype;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_item.organization_id) then raise exception 'Item invalido ou sem acesso.'; end if;
  if v_item.linked_event_kit_item_id is not null then
    raise exception 'Este item usa os tamanhos da camiseta do evento; use "Sincronizar variantes" em vez de cadastrar manualmente.';
  end if;
  if p_id is not null then
    select * into v_existing_variant from public.store_item_variants where id = p_id and store_item_id = p_store_item_id;
    if found and v_existing_variant.linked_event_kit_item_variant_id is not null then
      raise exception 'Esta variante e sincronizada automaticamente a partir do item de kit do evento; nao pode ser editada pela loja.';
    end if;
  end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Nome da variante obrigatorio.'; end if;
  if nullif(trim(coalesce(p_value, '')), '') is null then raise exception 'Valor da variante obrigatorio.'; end if;

  if p_id is null then
    insert into public.store_item_variants (store_item_id, name, value, price_adjustment, is_active, sort_order)
    values (p_store_item_id, trim(p_name), trim(p_value), coalesce(p_price_adjustment, 0), coalesce(p_is_active, true), coalesce(p_sort_order, 0))
    returning id into v_id;
  else
    update public.store_item_variants set
      name = trim(p_name), value = trim(p_value), price_adjustment = coalesce(p_price_adjustment, 0),
      is_active = coalesce(p_is_active, true), sort_order = coalesce(p_sort_order, 0)
    where id = p_id and store_item_id = p_store_item_id
    returning id into v_id;
    if v_id is null then raise exception 'Variante nao encontrada.'; end if;
  end if;
  return v_id;
end; $$;

create or replace function public.set_store_item_stock("p_store_item_id" uuid, "p_variant_id" uuid, "p_total_quantity" integer) returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_item public.store_items%rowtype; v_committed integer;
begin
  if not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_item.organization_id) then raise exception 'Item invalido ou sem acesso.'; end if;
  if v_item.linked_event_kit_item_id is not null then
    raise exception 'Este item usa o estoque compartilhado da camiseta do evento; ajuste o estoque pela configuracao do evento (item de kit).';
  end if;
  if p_total_quantity < 0 then raise exception 'Quantidade invalida.'; end if;
  if p_variant_id is not null and not exists (select 1 from public.store_item_variants where id = p_variant_id and store_item_id = p_store_item_id) then
    raise exception 'Variante nao pertence ao item.';
  end if;

  select coalesce(reserved_quantity, 0) + coalesce(delivered_quantity, 0) into v_committed
  from public.store_item_inventory where store_item_id = p_store_item_id and variant_id is not distinct from p_variant_id;
  if v_committed is not null and p_total_quantity < v_committed then
    raise exception 'Quantidade total nao pode ser menor que o ja reservado/entregue (%).', v_committed;
  end if;

  insert into public.store_item_inventory (event_id, store_item_id, variant_id, total_quantity)
  values (v_item.event_id, p_store_item_id, p_variant_id, p_total_quantity)
  on conflict (store_item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set total_quantity = excluded.total_quantity, updated_at = now();
end; $$;

-- ============================================================
-- 6) create_store_order / add_product_to_cart_order / deliver_store_order_
--    item / admin_grant_store_item / cancel_store_order / undo_store_
--    order_item_delivery -- passam a chamar as funcoes centralizadas em vez
--    de mexer direto em store_item_inventory. Nenhuma mudanca de
--    comportamento pra item NAO vinculado (mesma logica, so movida pra
--    dentro da funcao auxiliar); item vinculado passa a usar o estoque
--    compartilhado do evento.
-- ============================================================

create or replace function public.create_store_order("p_event_id" uuid, "p_items" jsonb, "p_payment_method" text, "p_notes" text default null) returns table(store_order_id uuid, order_number text, final_amount numeric)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_actor uuid := auth.uid(); v_event public.events%rowtype; v_order_id uuid; v_order_number text;
  v_item record; v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
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

    perform public.reserve_store_item_stock(v_store_item.id, v_item.variant_id, v_item.quantity);

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
  v_variant public.store_item_variants%rowtype;
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

  perform public.reserve_store_item_stock(v_store_item.id, p_variant_id, p_quantity);

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

create or replace function public.deliver_store_order_item(p_store_order_item_id uuid) returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para entregar itens da loja.'; end if;
  select * into v_line from public.store_order_items where id = p_store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_line.status = 'delivered' then return true; end if;
  if v_line.status <> 'confirmed' then raise exception 'Item precisa estar confirmado (pago) para ser entregue.'; end if;

  perform public.deliver_store_item_stock(v_line.store_item_id, v_line.variant_id, v_line.quantity);

  update public.store_order_items set status = 'delivered', delivered_at = now() where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivered', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object('actor_user_id', auth.uid()));
  return true;
end; $$;

create or replace function public.undo_store_order_item_delivery("p_store_order_item_id" uuid) returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para desfazer entrega da loja.'; end if;
  select * into v_line from public.store_order_items where id = p_store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_line.status <> 'delivered' then raise exception 'Item nao esta entregue.'; end if;

  perform public.undo_deliver_store_item_stock(v_line.store_item_id, v_line.variant_id, v_line.quantity);

  update public.store_order_items set status = 'confirmed', delivered_at = null where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivery_undone', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object('actor_user_id', auth.uid()));
  return true;
end; $$;

create or replace function public.cancel_store_order("p_store_order_id" uuid, "p_reason" text) returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_actor uuid := auth.uid(); v_order public.store_orders%rowtype; v_line record;
begin
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.current_user_has_permission('store.manage')) then raise exception 'Sem permissao para cancelar este pedido.'; end if;
  if v_order.status = 'cancelled' then return; end if;
  if exists (select 1 from public.store_order_items where store_order_id = p_store_order_id and status = 'delivered') then
    raise exception 'Pedido possui item entregue; nao pode ser cancelado.';
  end if;

  for v_line in select * from public.store_order_items where store_order_id = p_store_order_id and status <> 'cancelled' for update loop
    perform public.release_store_item_reservation(v_line.store_item_id, v_line.variant_id, v_line.quantity);
    update public.store_order_items set status = 'cancelled' where id = v_line.id;
  end loop;

  update public.store_orders set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = p_store_order_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_cancelled', 'store_orders', p_store_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'reason', p_reason));
end; $$;

-- admin_grant_store_item (concessao administrativa, migration 53): so troca
-- o bloco de estoque inline por reserve_store_item_stock -- resto identico
-- (motivo/ator/timestamp/historico em audit_logs, cortesia/cobrar, nunca
-- cria ingresso).
create or replace function public.admin_grant_store_item(
  p_ticket_id uuid, p_store_item_id uuid, p_variant_id uuid, p_quantity integer,
  p_is_courtesy boolean, p_reason text default null
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_order public.orders%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
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

  perform public.reserve_store_item_stock(v_store_item.id, p_variant_id, p_quantity);

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
      'final_amount', v_line_total, 'origin', 'admin', 'reason', nullif(trim(coalesce(p_reason,'')),''),
      'linked_event_kit_item_id', v_store_item.linked_event_kit_item_id));

  return v_item_id;
end; $$;

-- ============================================================
-- 7) list_store_items_for_event -- disponibilidade de estoque passa a vir
--    de event_kit_item_variant_inventory quando o item e vinculado (nunca
--    de store_item_inventory pra essas linhas -- nenhuma linha e criada la).
-- ============================================================
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
    coalesce(kit_inv.total_quantity, store_inv.total_quantity, 0),
    coalesce(kit_inv.reserved_quantity, store_inv.reserved_quantity, 0),
    coalesce(kit_inv.delivered_quantity, store_inv.delivered_quantity, 0),
    case
      when si.linked_event_kit_item_id is not null then
        case when coalesce(eki.shirt_supply_mode, 'stock') = 'made_to_order' then null
          else greatest(coalesce(kit_inv.total_quantity, 0) - coalesce(kit_inv.reserved_quantity, 0) - coalesce(kit_inv.delivered_quantity, 0), 0)
        end
      when si.supply_mode = 'made_to_order' then null
      else greatest(coalesce(store_inv.total_quantity, 0) - coalesce(store_inv.reserved_quantity, 0) - coalesce(store_inv.delivered_quantity, 0), 0)
    end
  from public.store_items si
  left join public.event_kit_items eki on eki.id = si.linked_event_kit_item_id
  left join public.store_item_variants siv on siv.store_item_id = si.id and siv.is_active
  left join public.event_kit_item_variant_inventory kit_inv
    on si.linked_event_kit_item_id is not null and kit_inv.kit_item_id = si.linked_event_kit_item_id and kit_inv.variant_id = siv.linked_event_kit_item_variant_id
  left join public.store_item_inventory store_inv
    on si.linked_event_kit_item_id is null and store_inv.store_item_id = si.id and store_inv.variant_id is not distinct from siv.id
  where (si.event_id = p_event_id or si.event_id is null) and si.is_active and si.visibility = 'public'
  order by si.sort_order, si.name, siv.sort_order, siv.name;
$$;

grant execute on function public.list_store_items_for_event(uuid) to anon, authenticated, service_role;

commit;
