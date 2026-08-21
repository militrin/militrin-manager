-- Loja: ciclo de vida do produto (desativar/reativar/excluir com seguranca)
-- + preco com desconto (valor + desconto percentual/fixo, com snapshot no
-- pedido). Nao cria arquitetura paralela -- reaproveita o que ja existe:
--
-- DESATIVAR/REATIVAR: store_items.is_active JA EXISTE e JA E respeitado por
-- TODAS as RPCs de escolha/compra/concessao (create_store_order,
-- add_product_to_cart_order, admin_grant_store_item, list_store_items_for_
-- event -- confirmado por leitura de cada uma antes de escrever esta
-- migration: todas ja filtram "and is_active"/"si.is_active"). Ou seja,
-- "produto desativado nao pode entrar em novo pedido/concessao" JA e
-- garantido no backend hoje -- nao existia so uma ACAO ADMINISTRATIVA
-- dedicada e auditada pra ligar/desligar essa coluna (upsert_store_item
-- teria que reenviar o produto inteiro, sem registrar em audit_logs).
-- set_store_item_active fecha exatamente essa lacuna, no mesmo padrao ja
-- usado por set_coupon_active.
--
-- EXCLUIR: investigacao das FKs de store_items confirmou:
--   store_item_variants   -> ON DELETE CASCADE (conteudo proprio do item,
--                             seguro apagar junto)
--   store_item_inventory  -> ON DELETE CASCADE (idem)
--   store_item_images     -> ON DELETE CASCADE (idem)
--   store_order_items     -> SEM cascade (bloqueia DELETE automaticamente)
--   order_items (compre junto) -> SEM cascade (bloqueia DELETE automaticamente)
--   coupon_product_scopes -> ON DELETE CASCADE (config de cupom, nao e
--                             "movimentacao" -- mesmo tratamento que
--                             delete_or_archive_coupon ja da ao vinculo
--                             inverso: limpa o vinculo, nunca bloqueia por
--                             causa dele)
-- delete_store_item PRE-CHECA store_order_items e order_items (pedido,
-- reserva E entrega sao a MESMA linha, so status diferente -- checar
-- "existe qualquer linha" ja cobre as 3 categorias pedidas) antes de
-- tentar apagar, devolvendo a mensagem amigavel pedida em vez de deixar o
-- Postgres estourar um erro de FK cru. Mesmo padrao ja estabelecido em
-- delete_or_archive_coupon (verifica uso antes de decidir apagar).
-- linked_event_kit_item_id/linked_event_kit_item_variant_id APONTAM pra
-- event_kit_items/event_kit_item_variants -- nunca o contrario -- entao
-- excluir um store_item RIGOROSAMENTE NUNCA casceia pro lado do evento
-- (confirmado pela direcao da FK: store_items e o lado referenciador, nao o
-- referenciado).
--
-- DESCONTO: nenhum campo equivalente existe em store_items hoje (preco e
-- so "price"). Reaproveita o MESMO vocabulario ja usado por coupons
-- (discount_type 'percentage'/'fixed', discount_value) pra manter
-- consistencia de nomenclatura no projeto, mas em colunas proprias de
-- store_items -- e um desconto INTRINSECO do produto (sempre aplicado),
-- conceitualmente diferente de cupom (codigo opcional, redimivel). Preco
-- final e SEMPRE calculado/validado no backend (compute_store_item_final_
-- price), nunca so no frontend. store_order_items ganha discount_type/
-- discount_value/final_unit_price como SNAPSHOT -- unit_price continua
-- representando o preco unitario ANTES do desconto (mesma semantica de
-- sempre, so agora explicitamente "pre-desconto"), final_amount continua
-- sendo o valor total realmente cobrado (agora com desconto aplicado).
-- Mudar o desconto do produto depois nunca reescreve pedidos ja feitos,
-- porque essas 3 colunas sao copiadas pro pedido no momento da compra/
-- concessao, nunca recalculadas a partir de store_items.
--
-- O desconto do produto vale em TODOS os canais do MESMO produto (revisao
-- desta migration antes do db push): loja solo (create_store_order),
-- concessao administrativa cobrada (admin_grant_store_item) e compre junto
-- no checkout do ingresso (add_product_to_cart_order/set_cart_order_item_
-- quantity, canal que usa order_items em vez de store_order_items -- ver
-- secao 5b) agora chamam a MESMA compute_store_item_final_price, na MESMA
-- ordem deterministica: 1) preco original do produto -> 2) desconto proprio
-- -> 3) cupom (quando aplicavel, so no compre junto -- apply_cart_coupon
-- NAO e alterada, ela ja opera sobre order_items.unit_price, que passa a
-- chegar ali JA com o desconto proprio aplicado) -> 4) preco final. Nenhum
-- calculo e duplicado; order_items ganha 1 unico campo novo (secao 5b)
-- depois de confirmado que a estrutura existente (unit_price/discount_
-- amount/final_amount, exclusivos do cupom) nao bastava pra reconstruir o
-- preco base do produto no momento da compra.
begin;

-- ============================================================
-- 1) Desconto no produto (Valor + Desconto)
-- ============================================================
alter table public.store_items
  add column if not exists discount_type text,
  add column if not exists discount_value numeric(10,2) not null default 0;

alter table public.store_items
  drop constraint if exists store_items_discount_type_check;
alter table public.store_items
  add constraint store_items_discount_type_check check (discount_type is null or discount_type in ('percentage','fixed'));

alter table public.store_items
  drop constraint if exists store_items_discount_value_check;
alter table public.store_items
  add constraint store_items_discount_value_check check (discount_value >= 0);

-- Snapshot do desconto no pedido -- nunca recalculado a partir do produto
-- depois de criado. unit_price mantem o significado de sempre (preco
-- unitario ANTES do desconto: price + price_adjustment da variante);
-- final_amount continua sendo o total realmente cobrado (agora com
-- desconto ja aplicado).
alter table public.store_order_items
  add column if not exists discount_type text,
  add column if not exists discount_value numeric(10,2) not null default 0,
  add column if not exists final_unit_price numeric(10,2) not null default 0;

alter table public.store_order_items
  drop constraint if exists store_order_items_discount_type_check;
alter table public.store_order_items
  add constraint store_order_items_discount_type_check check (discount_type is null or discount_type in ('percentage','fixed'));

-- Backfill das linhas ja existentes (criadas antes desta migration, sem
-- desconto): final_unit_price = unit_price (nenhum desconto foi aplicado).
update public.store_order_items set final_unit_price = unit_price where final_unit_price = 0 and unit_price <> 0;

-- ------------------------------------------------------------
-- validate_store_item_discount: valida a CONFIGURACAO do produto (chamada
-- no cadastro/edicao, contra o preco BASE "Valor"). Percentual 0-100; fixo
-- >=0 e nunca maior que o preco base -- exatamente as regras pedidas.
-- ------------------------------------------------------------
create or replace function public.validate_store_item_discount(p_price numeric, p_discount_type text, p_discount_value numeric)
returns void language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  if p_discount_type is null then
    if coalesce(p_discount_value, 0) <> 0 then raise exception 'Informe um tipo de desconto ou zere o valor do desconto.'; end if;
    return;
  end if;
  if p_discount_type not in ('percentage','fixed') then raise exception 'Tipo de desconto invalido: %.', p_discount_type; end if;
  if p_discount_value is null or p_discount_value < 0 then raise exception 'Valor do desconto invalido.'; end if;
  if p_discount_type = 'percentage' and p_discount_value > 100 then raise exception 'Desconto percentual nao pode ser maior que 100%%.'; end if;
  if p_discount_type = 'fixed' and p_discount_value > p_price then raise exception 'Desconto em R$ nao pode ser maior que o preco base do produto.'; end if;
end; $$;

-- ------------------------------------------------------------
-- compute_store_item_final_price: calculo PURO (sem validar/levantar) --
-- usado sobre o preco unitario da LINHA (base + ajuste de variante), nunca
-- so o preco base, pra que o desconto valha igualmente pra qualquer
-- tamanho escolhido. Sempre floor em 0 -- preco final nunca negativo, com
-- ou sem variante, mesmo em combinacoes que a validacao de cadastro (feita
-- so contra o preco base) nao previu.
-- ------------------------------------------------------------
create or replace function public.compute_store_item_final_price(p_unit_price numeric, p_discount_type text, p_discount_value numeric)
returns numeric language sql immutable set search_path to 'public', 'pg_temp' as $$
  select greatest(
    case
      when p_discount_type = 'percentage' then p_unit_price * (1 - least(coalesce(p_discount_value,0),100) / 100.0)
      when p_discount_type = 'fixed' then p_unit_price - coalesce(p_discount_value,0)
      else p_unit_price
    end,
    0
  );
$$;

-- ============================================================
-- 2) set_store_item_active -- desativar/reativar auditado (mesmo padrao de
--    set_coupon_active). Nunca apaga nada; estoque, variantes, vinculo com
--    o evento e pedidos antigos ficam 100% intocados -- so a coluna
--    is_active muda.
-- ============================================================
create or replace function public.set_store_item_active(p_store_item_id uuid, p_is_active boolean)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_item public.store_items%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_item.organization_id) then raise exception 'Item da loja nao encontrado ou sem acesso.'; end if;
  update public.store_items set is_active = coalesce(p_is_active, true), updated_at = now() where id = p_store_item_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values (case when coalesce(p_is_active, true) then 'store_item_activated' else 'store_item_deactivated' end,
    'store_items', p_store_item_id, v_item.event_id, jsonb_build_object('actor_user_id', v_actor, 'name', v_item.name));
  return true;
end; $$;

revoke all on function public.set_store_item_active(uuid, boolean) from public, anon;
grant execute on function public.set_store_item_active(uuid, boolean) to authenticated, service_role;

-- ============================================================
-- 3) delete_store_item -- exclusao fisica so quando comprovadamente segura.
--    NUNCA usa cascade destrutivo sobre historico: pre-checa store_order_
--    items e order_items (pedido/reserva/entrega sao a MESMA linha, so
--    status diferente -- "existe qualquer linha" cobre as 3 categorias
--    pedidas) e devolve mensagem amigavel em vez de deixar a FK estourar
--    um erro cru. Se seguro: limpa so o vinculo de configuracao de cupom
--    (coupon_product_scopes -- nao e "movimentacao", mesmo tratamento que
--    delete_or_archive_coupon ja da ao vinculo inverso) e apaga o produto
--    -- variantes/estoque proprio/imagens cascade automaticamente (sao
--    conteudo do proprio produto, nunca do evento).
--
--    Produto vinculado (linked_event_kit_item_id): a FK aponta do produto
--    PRO evento, nunca o contrario -- apagar o produto jamais cascade pro
--    item de kit/variantes/estoque do evento. Testado explicitamente.
-- ============================================================
create or replace function public.delete_store_item(p_store_item_id uuid)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_item public.store_items%rowtype; v_has_movement boolean;
begin
  if v_actor is null or not public.current_user_has_permission('store.manage') then raise exception 'Sem permissao para gerenciar a lojinha.'; end if;
  select * into v_item from public.store_items where id = p_store_item_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_item.organization_id) then raise exception 'Item da loja nao encontrado ou sem acesso.'; end if;

  select (
    exists(select 1 from public.store_order_items where store_item_id = p_store_item_id)
    or exists(select 1 from public.order_items where store_item_id = p_store_item_id)
  ) into v_has_movement;

  if v_has_movement then
    raise exception 'Este produto já possui movimentações e não pode ser excluído. Desative-o para impedir novas vendas.';
  end if;

  delete from public.coupon_product_scopes where store_item_id = p_store_item_id;
  delete from public.store_items where id = p_store_item_id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_item_deleted', 'store_items', p_store_item_id, v_item.event_id,
    jsonb_build_object('actor_user_id', v_actor, 'name', v_item.name, 'was_linked_event_kit_item_id', v_item.linked_event_kit_item_id));
end; $$;

revoke all on function public.delete_store_item(uuid) from public, anon;
grant execute on function public.delete_store_item(uuid) to authenticated, service_role;

-- ============================================================
-- 4) upsert_store_item -- ganha p_discount_type/p_discount_value (valida
--    via validate_store_item_discount, contra o preco base que esta sendo
--    salvo). Assinatura muda -- precisa de drop.
-- ============================================================
drop function if exists public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text, uuid);

create function public.upsert_store_item(
  p_id uuid, p_event_id uuid, p_name text, p_slug text, p_description text,
  p_price numeric, p_requires_variant boolean, p_is_active boolean, p_sort_order integer,
  p_supply_mode text default 'stock', p_available_all_events boolean default false,
  p_visibility text default 'public', p_linked_event_kit_item_id uuid default null,
  p_discount_type text default null, p_discount_value numeric default 0
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
  perform public.validate_store_item_discount(p_price, p_discount_type, p_discount_value);

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
    insert into public.store_items (organization_id, event_id, name, slug, description, price, requires_variant, is_active, sort_order, supply_mode, visibility, linked_event_kit_item_id, discount_type, discount_value)
    values (v_org, v_stored_event_id, trim(p_name), trim(p_slug), nullif(trim(coalesce(p_description, '')), ''),
      p_price, v_requires_variant, coalesce(p_is_active, true), coalesce(p_sort_order, 0), coalesce(p_supply_mode, 'stock'), coalesce(p_visibility, 'public'), p_linked_event_kit_item_id,
      p_discount_type, coalesce(p_discount_value, 0))
    returning id into v_id;
  else
    update public.store_items set
      organization_id = v_org, event_id = v_stored_event_id,
      name = trim(p_name), slug = trim(p_slug), description = nullif(trim(coalesce(p_description, '')), ''),
      price = p_price, requires_variant = v_requires_variant, is_active = coalesce(p_is_active, true),
      sort_order = coalesce(p_sort_order, 0), supply_mode = coalesce(p_supply_mode, 'stock'), visibility = coalesce(p_visibility, 'public'),
      linked_event_kit_item_id = p_linked_event_kit_item_id, discount_type = p_discount_type, discount_value = coalesce(p_discount_value, 0),
      updated_at = now()
    where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'Item da loja nao encontrado.'; end if;
  end if;

  if p_linked_event_kit_item_id is not null and p_linked_event_kit_item_id is distinct from v_previous_link then
    perform public.sync_linked_store_item_variants(v_id);
  end if;

  return v_id;
end; $$;

grant execute on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text, uuid, text, numeric) to authenticated, service_role;
revoke all on function public.upsert_store_item(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean, text, uuid, text, numeric) from anon;

-- ============================================================
-- 5) create_store_order / admin_grant_store_item -- aplicam o desconto do
--    produto sobre o preco unitario da LINHA (base + ajuste de variante) e
--    gravam o snapshot (discount_type/discount_value/final_unit_price) em
--    store_order_items.
--
--    CORRECAO (revisao desta mesma migration, antes do db push): o desconto
--    do produto precisa valer em TODOS os canais de venda do MESMO produto,
--    nao so na loja solo/concessao -- add_product_to_cart_order (compre
--    junto) e set_cart_order_item_quantity tambem sao redefinidas mais
--    abaixo (secao 5b) pra aplicar o MESMO compute_store_item_final_price
--    sobre order_items.unit_price. no ordem deterministica pedida: 1) preco
--    original do produto -> 2) desconto proprio -> 3) cupom -> 4) preco
--    final. apply_cart_coupon (motor de cupom) NAO E ALTERADA: ela ja
--    calcula desconto de cupom em cima de order_items.unit_price*quantity
--    (v_line_subtotal) -- ao gravar ali o preco JA com o desconto proprio
--    aplicado, o cupom passa a incidir automaticamente sobre o subtotal
--    promocional, sem duplicar calculo e sem reescrever o motor de cupom.
-- ============================================================
create or replace function public.create_store_order("p_event_id" uuid, "p_items" jsonb, "p_payment_method" text, "p_notes" text default null) returns table(store_order_id uuid, order_number text, final_amount numeric)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_actor uuid := auth.uid(); v_event public.events%rowtype; v_order_id uuid; v_order_number text;
  v_item record; v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_unit_price numeric; v_final_unit_price numeric; v_line_total numeric; v_total numeric := 0; v_paid boolean; v_participant_id uuid;
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

create or replace function public.admin_grant_store_item(
  p_ticket_id uuid, p_store_item_id uuid, p_variant_id uuid, p_quantity integer,
  p_is_courtesy boolean, p_reason text default null
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_order public.orders%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_participant_id uuid; v_unit_price numeric; v_final_unit_price numeric; v_line_total numeric; v_order_id uuid; v_order_number text; v_item_id uuid;
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
  v_final_unit_price := public.compute_store_item_final_price(v_unit_price, v_store_item.discount_type, v_store_item.discount_value);

  perform public.reserve_store_item_stock(v_store_item.id, p_variant_id, p_quantity);

  v_line_total := case when coalesce(p_is_courtesy, false) then 0 else round(v_final_unit_price * p_quantity, 2) end;
  v_order_number := 'ADMIN-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.store_orders (organization_id, event_id, user_id, participant_id, order_number, status, payment_method, payment_status, base_amount, final_amount, notes, confirmed_at)
  values (v_ticket.organization_id, v_ticket.event_id, v_order.user_id, v_participant_id, v_order_number,
    case when coalesce(p_is_courtesy, false) then 'confirmed' else 'pending' end,
    case when coalesce(p_is_courtesy, false) then 'admin_courtesy' else 'admin_charge' end,
    case when coalesce(p_is_courtesy, false) then 'paid' else 'pending' end,
    v_line_total, v_line_total,
    nullif(trim(coalesce(p_reason, '')), ''), case when coalesce(p_is_courtesy, false) then now() end)
  returning id into v_order_id;

  insert into public.store_order_items (store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status, discount_type, discount_value, final_unit_price)
  values (v_order_id, v_store_item.id, p_variant_id, p_quantity,
    case when coalesce(p_is_courtesy, false) then 0 else v_unit_price end, v_line_total,
    case when coalesce(p_is_courtesy, false) then 'confirmed' else 'reserved' end,
    v_store_item.discount_type, v_store_item.discount_value, case when coalesce(p_is_courtesy, false) then 0 else v_final_unit_price end)
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
-- 5b) order_items (canal "compre junto") -- investigacao confirmou que essa
--     tabela e polimorfica (ticket/product na mesma linha) e ja tem
--     unit_price/discount_amount/final_amount, mas discount_amount e
--     order_item_discounts sao EXCLUSIVOS do motor de CUPOM (coupon_id/
--     coupon_code NOT NULL, unique(order_item_id) -- nao da pra reusar sem
--     quebrar essa semantica nem colidir com a linha que apply_cart_coupon
--     ja mantem por item). Pra reconstruir corretamente o historico (preco
--     base do produto no momento da compra, alem do que ja existe --
--     desconto de cupom em discount_amount e preco final em final_amount),
--     falta exatamente 1 campo: o preco unitario ANTES do desconto proprio
--     do produto. Sem ele, uma vez que unit_price passa a guardar o preco
--     JA promocional, o preco base original do produto (ex.: R$55 do
--     exemplo) ficaria irrecuperavel -- reconstrui-lo via join em
--     store_items.price seria ERRADO, porque esse valor muda no futuro.
--     O desconto proprio do produto (em R$) e sempre reconstruivel por
--     subtracao (product_base_unit_price - unit_price) -- por isso NAO
--     duplicamos discount_type/discount_value aqui tambem, exatamente como
--     pedido ("nao criar colunas redundantes"). Nulo pra linhas de ingresso
--     (item_kind='ticket'), mesmo padrao ja usado por shirt_type/shirt_size
--     nesta mesma tabela polimorfica (coluna so preenchida quando relevante
--     ao item_kind).
-- ============================================================
alter table public.order_items
  add column if not exists product_base_unit_price numeric(10,2);

alter table public.order_items
  drop constraint if exists order_items_product_base_unit_price_check;
alter table public.order_items
  add constraint order_items_product_base_unit_price_check check (product_base_unit_price is null or product_base_unit_price >= 0);

-- add_product_to_cart_order / set_cart_order_item_quantity -- unit_price
-- passa a ser o preco JA com o desconto proprio do produto aplicado
-- (compute_store_item_final_price, mesma funcao usada pela loja solo e pela
-- concessao administrativa -- nenhum calculo duplicado). apply_cart_coupon
-- (definida em 20260836000000, NAO redefinida aqui) continua calculando o
-- desconto de cupom em cima de unit_price*quantity sem nenhuma mudanca --
-- como unit_price ja chega promocional, o cupom passa a incidir
-- automaticamente sobre o subtotal promocional (ordem determinista: preco
-- original -> desconto proprio -> cupom -> preco final), sem duplicar
-- desconto nem reescrever o motor de cupom.
create or replace function public.add_product_to_cart_order(p_order_id uuid, p_store_item_id uuid, p_variant_id uuid default null, p_quantity integer default 1)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_store_item public.store_items%rowtype;
  v_variant public.store_item_variants%rowtype;
  v_base_unit_price numeric; v_unit_price numeric; v_existing public.order_items%rowtype; v_item_id uuid; v_new_quantity integer;
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

  select * into v_existing from public.order_items
    where order_id = p_order_id and item_kind = 'product' and store_item_id = v_store_item.id
      and store_item_variant_id is not distinct from p_variant_id
      and status not in ('cancelled','expired','refunded','transferred')
    for update;

  perform public.reserve_store_item_stock(v_store_item.id, p_variant_id, p_quantity);

  if found and v_existing.id is not null then
    v_new_quantity := v_existing.quantity + p_quantity;
    update public.order_items
      set quantity = v_new_quantity, unit_price = v_unit_price, product_base_unit_price = v_base_unit_price,
        final_amount = round(v_unit_price * v_new_quantity, 2), updated_at = now()
      where id = v_existing.id
      returning id into v_item_id;
  else
    insert into public.order_items(order_id, event_id, item_kind, store_item_id, store_item_variant_id, quantity, unit_price, product_base_unit_price, discount_amount, final_amount, status, ownership_status)
    values(p_order_id, v_order.event_id, 'product', v_store_item.id, p_variant_id, p_quantity, v_unit_price, v_base_unit_price, 0, round(v_unit_price * p_quantity, 2), 'reserved', 'unassigned')
    returning id into v_item_id;
  end if;

  perform public.apply_cart_coupon(p_order_id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_added', 'orders', p_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'store_item_id', v_store_item.id, 'variant_id', p_variant_id, 'quantity_added', p_quantity, 'order_item_id', v_item_id, 'base_unit_price', v_base_unit_price, 'unit_price', v_unit_price));

  return jsonb_build_object('order_item_ids', array[v_item_id], 'unit_price', v_unit_price);
end; $$;

-- set_cart_order_item_quantity (definida em 20260836000000) -- mesma
-- correcao: recalcula o preco JA com o desconto proprio do produto sempre
-- que a quantidade muda, em vez de reverter pro preco cheio.
create or replace function public.set_cart_order_item_quantity(p_order_item_id uuid, p_quantity integer)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_inv public.store_item_inventory%rowtype; v_base_unit_price numeric; v_unit_price numeric; v_delta integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item nao encontrado.'; end if;
  if v_item.item_kind <> 'product' then raise exception 'Somente itens de produto tem quantidade ajustavel por aqui.'; end if;
  select * into v_order from public.orders where id = v_item.order_id for update;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;
  if v_item.status = 'cancelled' then raise exception 'Item ja foi removido do carrinho.'; end if;

  select * into v_store_item from public.store_items where id = v_item.store_item_id;
  if not found then raise exception 'Produto do item nao encontrado.'; end if;
  v_base_unit_price := v_store_item.price;
  if v_item.store_item_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = v_item.store_item_variant_id;
    if found then v_base_unit_price := v_base_unit_price + coalesce(v_variant.price_adjustment, 0); end if;
  end if;
  v_unit_price := public.compute_store_item_final_price(v_base_unit_price, v_store_item.discount_type, v_store_item.discount_value);

  v_delta := p_quantity - v_item.quantity;

  if v_delta <> 0 then
    select * into v_inv from public.store_item_inventory where store_item_id = v_item.store_item_id and variant_id is not distinct from v_item.store_item_variant_id for update;
    if found then
      if v_delta > 0 and (coalesce(v_inv.total_quantity,0) - coalesce(v_inv.reserved_quantity,0) - coalesce(v_inv.delivered_quantity,0) < v_delta) then
        raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK', detail=jsonb_build_object('code','PRODUCT_OUT_OF_STOCK','message',format('Estoque insuficiente para %s.', v_store_item.name))::text;
      end if;
      update public.store_item_inventory set reserved_quantity = greatest(reserved_quantity + v_delta, 0), updated_at = now() where id = v_inv.id;
    end if;
  end if;

  update public.order_items
    set quantity = p_quantity, unit_price = v_unit_price, product_base_unit_price = v_base_unit_price,
      final_amount = round(v_unit_price * p_quantity, 2), updated_at = now()
    where id = p_order_item_id;

  perform public.apply_cart_coupon(v_order.id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_quantity_changed', 'orders', v_order.id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'order_item_id', p_order_item_id, 'quantity', p_quantity, 'previous_quantity', v_item.quantity));

  return jsonb_build_object('order_id', v_order.id, 'order_item_id', p_order_item_id, 'quantity', p_quantity);
end; $$;

-- ============================================================
-- 6) list_store_items_for_event -- ganha discount_type/discount_value/
--    final_price (calculado sobre o preco base, pra exibicao no catalogo
--    e no card sem o frontend reimplementar a formula). Continua so
--    'public'+'is_active' (produto desativado nunca aparece aqui).
-- ============================================================
drop function if exists public.list_store_items_for_event(uuid);

create function public.list_store_items_for_event(p_event_id uuid) returns table(
  store_item_id uuid, event_id uuid, name text, slug text, description text,
  image_url text, images jsonb,
  price numeric, discount_type text, discount_value numeric, final_price numeric,
  requires_variant boolean, supply_mode text, sort_order integer,
  variant_id uuid, variant_name text, variant_value text, price_adjustment numeric,
  total_quantity integer, reserved_quantity integer, delivered_quantity integer, available_quantity integer
)
  language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select si.id, si.event_id, si.name, si.slug, si.description,
    (select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1),
    (select coalesce(jsonb_agg(jsonb_build_object('id', sii.id, 'url', sii.image_url, 'is_primary', sii.is_primary) order by sii.sort_order, sii.created_at), '[]'::jsonb)
       from public.store_item_images sii where sii.store_item_id = si.id),
    si.price, si.discount_type, si.discount_value, public.compute_store_item_final_price(si.price, si.discount_type, si.discount_value),
    si.requires_variant, si.supply_mode, si.sort_order,
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
