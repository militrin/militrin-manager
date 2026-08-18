-- Evolucao estrutural do carrinho: permitir que um PEDIDO de ingresso
-- (orders/order_items/payments, cadeia canonica) tambem contenha linhas de
-- PRODUTO da loja ("compre junto"), sem duplicar logica de pedido nem criar
-- um segundo checkout paralelo.
--
-- Decisao de escopo (confirmada explicitamente): a loja "solo" existente
-- (/minha-conta/loja, store_orders/store_order_items, com PIX e QR de
-- retirada proprios) permanece INTOCADA e continua coexistindo como um
-- segundo canal de compra de produto. Esta migration afeta apenas o
-- carrinho que nasce dentro do checkout de ingresso (/inscricao).
--
-- order_items ganha colunas nulas (aditivo, zero impacto em linhas
-- existentes, que continuam item_kind='ticket' por default): item_kind
-- discrimina 'ticket' (comportamento 100% inalterado) de 'product' (nova
-- linha, aponta para store_items/store_item_variants -- a MESMA fonte
-- canonica de produto e estoque ja usada pela loja solo, incluindo
-- store_item_inventory com o mesmo padrao total/reserved/delivered ja
-- auditado nesta sessao).
begin;

alter table public.order_items
  add column item_kind text not null default 'ticket',
  add column store_item_id uuid references public.store_items(id),
  add column store_item_variant_id uuid references public.store_item_variants(id);

alter table public.order_items
  add constraint order_items_item_kind_check check (item_kind in ('ticket','product'));

alter table public.order_items
  add constraint order_items_product_kind_shape_check check (
    (item_kind = 'ticket' and store_item_id is null)
    or
    (item_kind = 'product' and store_item_id is not null and ticket_category_id is null and batch_id is null
      and shirt_type is null and shirt_size is null and participant_id is null and registration_contact_id is null)
  );

comment on column public.order_items.item_kind is 'ticket = linha de ingresso (comportamento pre-existente, inalterado); product = linha de produto da loja adicionada via "compre junto" no mesmo pedido.';
comment on column public.order_items.store_item_id is 'Preenchido somente quando item_kind=product. Mesma tabela canonica store_items usada pela loja solo.';
comment on column public.order_items.store_item_variant_id is 'Preenchido quando o produto exige variante (store_items.requires_variant). Mesma tabela canonica store_item_variants.';

create index idx_order_items_store_item_id on public.order_items(store_item_id) where store_item_id is not null;

commit;
