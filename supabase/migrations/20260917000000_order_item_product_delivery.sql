-- BUG: QR de produto "compre junto" (order_items.qr_token, 20260916000000)
-- nao funcionava na Central de Operacoes nem no Modo Turbo -- nenhum dos
-- dois leitores sabia procurar por order_items ainda (so tickets.token e,
-- no Turbo, store_order_items.qr_token). order_items tambem nunca teve um
-- estado de ENTREGA fisica: order_items.status so cobre o ciclo comercial
-- (reserved/confirmed/cancelled/expired/refunded/transferred) -- 'delivered'
-- nao existia, porque produto "compre junto" nunca teve fluxo operacional de
-- retirada ate agora (mesma investigacao da migration anterior).
--
-- Esta migration:
--   1) acrescenta 'delivered' ao dominio de order_items.status +
--      order_items.delivered_at, mesmo padrao ja usado por
--      store_order_items.status/delivered_at;
--   2) cria deliver_order_item_product, RPC canonica e idempotente de
--      entrega para este dominio -- espelha deliver_store_order_item
--      (20260854000000) linha a linha, inclusive reusando
--      deliver_store_item_stock (a MESMA funcao de estoque ja usada por
--      store_order_items -- store_item_inventory e compartilhado entre os
--      dois dominios de pedido, nao duplicado). Mesma permissao canonica
--      (store.deliver) ja usada por deliver_store_order_item -- nenhuma
--      permissao nova criada.
--
-- A resolucao do QR (Central/Turbo) e feita em TypeScript (src/app/operacoes/
-- actions.ts), sempre por order_items.qr_token (coluna text) -- nunca um
-- cast pra uuid do token escaneado.
begin;

alter table public.order_items
  add column if not exists delivered_at timestamptz;

alter table public.order_items drop constraint if exists order_items_status_check;
alter table public.order_items add constraint order_items_status_check
  check (status = any (array['reserved','confirmed','delivered','cancelled','expired','refunded','transferred']));

comment on column public.order_items.delivered_at is 'Data/hora da entrega fisica do produto "compre junto" (item_kind=product). NULL para linha de ingresso (usa participant_kit_items/checkin, dominio separado) e para produto ainda nao entregue.';

create or replace function public.deliver_order_item_product(p_order_item_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then
    raise exception 'Sem permissao para entregar itens da loja.';
  end if;

  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  if v_item.item_kind <> 'product' then raise exception 'Item nao e um produto "compre junto".'; end if;

  select * into v_order from public.orders where id = v_item.order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then
    raise exception 'Pedido invalido ou sem acesso.';
  end if;

  -- Idempotente: reler o mesmo QR e confirmar de novo nunca falha nem
  -- duplica baixa de estoque -- mesmo padrao de deliver_store_order_item.
  if v_item.status = 'delivered' then return true; end if;
  if v_item.status <> 'confirmed' then raise exception 'Item precisa estar confirmado (pago) para ser entregue.'; end if;

  -- Mesma funcao de estoque ja usada por deliver_store_order_item --
  -- store_item_inventory e compartilhado entre store_order_items e
  -- order_items (ambos reservam via reserve_store_item_stock ao adicionar
  -- ao carrinho), nunca uma baixa de estoque paralela aqui.
  perform public.deliver_store_item_stock(v_item.store_item_id, v_item.store_item_variant_id, v_item.quantity);

  update public.order_items set status = 'delivered', delivered_at = now(), updated_at = now() where id = v_item.id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('order_item_product_delivered', 'order_items', v_item.id, v_item.event_id, jsonb_build_object(
    'actor_user_id', auth.uid(), 'order_id', v_order.id, 'store_item_id', v_item.store_item_id,
    'store_item_variant_id', v_item.store_item_variant_id, 'quantity', v_item.quantity
  ));

  return true;
end;
$$;

revoke all on function public.deliver_order_item_product(uuid) from public, anon;
grant execute on function public.deliver_order_item_product(uuid) to authenticated, service_role;

commit;
