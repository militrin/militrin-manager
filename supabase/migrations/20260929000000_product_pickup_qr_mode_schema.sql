-- FEATURE: QR de retirada configuravel por produto (3 modos: "QR por
-- unidade", "QR por compra/linha" -- comportamento historico -- e "Sem QR
-- de retirada"), pedido explicitamente pelo usuario apos auditoria completa
-- da arquitetura de QR de ticket/produto ja existente. Migration 1/10 --
-- so schema (colunas de config/snapshot + tabelas de unidade + RLS), nada
-- ainda le essas colunas -- o sistema se comporta 100% como hoje ate a
-- migration 2 (emissao) entrar em vigor.
--
-- DECISAO DE DESIGN (fechada com o usuario): mudar o modo de um produto NAO
-- PODE alterar silenciosamente pedidos ja existentes. Por isso a config
-- fica em store_items.pickup_qr_mode (o que vale para NOVAS compras a
-- partir de agora), e cada LINHA de pedido (order_items/store_order_items)
-- recebe seu proprio pickup_qr_mode "congelado" no momento da criacao (nas
-- RPCs da migration 2) -- nunca lido ao vivo via JOIN com store_items.
--
-- MODELO OPERACIONAL UNICO PARA "per_unit" (revisado apos auditoria desta
-- sessao): toda linha com pickup_qr_mode='per_unit' materializa 1 linha por
-- UNIDADE em order_item_pickup_units/store_order_item_pickup_units --
-- SEMPRE, inclusive quantity=1 (nao ha mais excecao "quantity=1 reaproveita
-- o qr_token da linha"). A primeira versao desta feature tinha essa
-- excecao e criava dois caminhos de codigo divergentes (resolucao/entrega/
-- undo por linha OU por unidade dependendo da quantidade, mais um caso de
-- borda inteiro dedicado a "quantity passou de 1 pra >1 no meio do
-- carrinho"). Um unico modelo -- sempre unidade quando per_unit, sem
-- excecao por quantidade -- elimina essa classe de bug inteira: a linha-mae
-- (order_items/store_order_items) so serve pra agregacao comercial
-- (preco/desconto/pedido); a IDENTIDADE de retirada de um item per_unit e
-- SEMPRE a unidade, nunca a linha. store_items.pickup_qr_mode='per_line' (o
-- modo historico) continua usando o qr_token da propria linha, sem
-- unidades -- unico modo que nunca materializa nada aqui.
--
-- order_items tambem guarda linhas de INGRESSO (item_kind='ticket'), que
-- nunca tiveram e nunca terao pickup_qr_mode (usam tickets.token) -- por
-- isso a coluna e NULLABLE ali, mesmo padrao ja usado para qr_token
-- (20260916000000). store_order_items so guarda produto, entao a coluna e
-- NOT NULL com DEFAULT, mesmo padrao ja usado para o qr_token dela
-- (20260860000000) -- "ADD COLUMN ... NOT NULL DEFAULT" backfilla toda
-- linha ja existente automaticamente (Postgres >= 11, sem reescrita de
-- tabela), preservando 100% o comportamento atual pra pedidos historicos.
begin;

alter table public.store_items
  add column if not exists pickup_qr_mode text not null default 'per_line';
alter table public.store_items drop constraint if exists store_items_pickup_qr_mode_check;
alter table public.store_items add constraint store_items_pickup_qr_mode_check
  check (pickup_qr_mode in ('per_unit', 'per_line', 'none'));
comment on column public.store_items.pickup_qr_mode is
  'Config de retirada do produto para NOVAS compras: per_unit (1 QR por unidade fisica, SEMPRE materializada em order_item_pickup_units/store_order_item_pickup_units, inclusive quantity=1), per_line (1 QR cobre a linha inteira -- comportamento historico, nunca materializa unidade), none (sem QR de retirada, entrega manual pela tela "Loja > Pedidos"). Mudar aqui NUNCA altera pedidos ja existentes -- cada order_items/store_order_items ja congelou seu proprio pickup_qr_mode na criacao da linha.';

alter table public.order_items
  add column if not exists pickup_qr_mode text;
alter table public.order_items drop constraint if exists order_items_pickup_qr_mode_check;
alter table public.order_items add constraint order_items_pickup_qr_mode_check
  check (pickup_qr_mode is null or pickup_qr_mode in ('per_unit', 'per_line', 'none'));
comment on column public.order_items.pickup_qr_mode is
  'Snapshot do modo de retirada do produto no momento em que esta linha foi criada (item_kind=product). NULL para item_kind=ticket. Nunca reflete mudancas posteriores em store_items.pickup_qr_mode.';

-- Backfill: toda linha de produto ja existente continua se comportando
-- EXATAMENTE como hoje -- 1 qr_token cobre a linha toda. Nunca materializa
-- unidade retroativamente (so as RPCs de escrita da migration 2 fazem
-- isso, so pra linhas NOVAS).
update public.order_items set pickup_qr_mode = 'per_line'
where item_kind = 'product' and pickup_qr_mode is null;

alter table public.store_order_items
  add column if not exists pickup_qr_mode text not null default 'per_line';
alter table public.store_order_items drop constraint if exists store_order_items_pickup_qr_mode_check;
alter table public.store_order_items add constraint store_order_items_pickup_qr_mode_check
  check (pickup_qr_mode in ('per_unit', 'per_line', 'none'));
comment on column public.store_order_items.pickup_qr_mode is
  'Snapshot do modo de retirada do produto no momento em que esta linha foi criada. Nunca reflete mudancas posteriores em store_items.pickup_qr_mode.';

-- ============================================================
-- Tabelas de unidade -- 1 linha por unidade fisica, so para linhas
-- pickup_qr_mode='per_unit' (qualquer quantity >= 1). Dominios continuam
-- paralelos (order_items "compre junto" vs store_order_items loja
-- standalone), decisao ja reafirmada em varias migrations anteriores
-- (20260825000000/20260916000000/20260917000000) -- por isso duas tabelas
-- espelhadas, nunca uma unificada.
--
-- Estoque: as unidades NUNCA disparam reserva/baixa propria -- isso
-- continua 100% controlado pela linha-mae (reserve_store_item_stock ja
-- roda 1 vez pra quantity inteiro no add-to-cart/checkout). A baixa de
-- ENTREGA no modo per_unit e feita por unidade (quantity=1 por chamada,
-- migration 4) -- ao final das N entregas o total bate com a quantity da
-- linha.
--
-- Indice: UNIQUE(linha_id, unit_index) ja e suficiente pra qualquer
-- consulta filtrando so por linha_id (leftmost prefix do indice composto)
-- -- nao precisa de um segundo indice so em linha_id (seria redundante,
-- so overhead de escrita sem ganho de leitura).
--
-- RLS espelha literalmente a policy ja existente em store_order_items
-- (store_order_items_select, remote_schema.sql linha ~18729): dono do
-- pedido OU staff com acesso a organizacao. Toda escrita passa por RPC
-- security definer -- nenhuma policy de insert/update/delete e necessaria.
-- ============================================================
create table public.order_item_pickup_units (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  unit_index integer not null check (unit_index >= 1),
  qr_token text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'confirmed', 'delivered', 'cancelled')),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_item_id, unit_index)
);
create unique index order_item_pickup_units_qr_token_key on public.order_item_pickup_units (qr_token);
comment on table public.order_item_pickup_units is
  'Materializa 1 linha por UNIDADE fisica quando order_items.pickup_qr_mode=''per_unit'' (produto "compre junto") -- SEMPRE, inclusive quantity=1. Modelo unico: nenhuma linha per_unit usa order_items.qr_token para retirada.';

alter table public.order_item_pickup_units enable row level security;
create policy "order_item_pickup_units_select" on public.order_item_pickup_units for select to authenticated
using (
  exists (
    select 1 from public.order_items oi
    join public.orders o on o.id = oi.order_id
    where oi.id = order_item_pickup_units.order_item_id
      and (o.user_id = auth.uid() or public.user_can_access_organization(auth.uid(), o.organization_id))
  )
);

create table public.store_order_item_pickup_units (
  id uuid primary key default gen_random_uuid(),
  store_order_item_id uuid not null references public.store_order_items(id) on delete cascade,
  unit_index integer not null check (unit_index >= 1),
  qr_token text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'confirmed', 'delivered', 'cancelled')),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_order_item_id, unit_index)
);
create unique index store_order_item_pickup_units_qr_token_key on public.store_order_item_pickup_units (qr_token);
comment on table public.store_order_item_pickup_units is
  'Materializa 1 linha por UNIDADE fisica quando store_order_items.pickup_qr_mode=''per_unit'' (loja standalone) -- SEMPRE, inclusive quantity=1. Modelo unico: nenhuma linha per_unit usa store_order_items.qr_token para retirada.';

alter table public.store_order_item_pickup_units enable row level security;
create policy "store_order_item_pickup_units_select" on public.store_order_item_pickup_units for select to authenticated
using (
  exists (
    select 1 from public.store_order_items soi
    join public.store_orders so on so.id = soi.store_order_id
    where soi.id = store_order_item_pickup_units.store_order_item_id
      and (so.user_id = auth.uid() or public.user_can_access_organization(auth.uid(), so.organization_id))
  )
);

commit;
