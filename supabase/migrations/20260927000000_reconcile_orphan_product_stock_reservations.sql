-- Reconciliacao pontual de reserved_quantity orfa em store_item_inventory.
--
-- CAUSA: ate 20260926000000, _apply_terminal_order_payment_status/
-- remove_cart_order_item nao liberavam reserved_quantity de order_items
-- item_kind='product' (nem store_order_items). A correcao ja fecha a causa
-- para toda entrega/expiracao/cancelamento/estorno DAQUI PRA FRENTE -- esta
-- migration so limpa o residuo que ja tinha acumulado ANTES dela existir.
--
-- AUDITORIA READ-ONLY (reconfirmada nesta sessao, producao, service_role,
-- nenhum dado alterado -- ver relatorio entregue ao usuario): nenhum dos
-- pedidos MIL-2026-00001085/1086/1087/1089 mudou de estado desde a
-- auditoria anterior. Cruzamento COMPLETO por delivered_quantity confirma a
-- formula (nao so a subtracao de 2 unidades):
--
--   Copo Termico Logo 360 (store_item_id 498cd6d5-4b22-44ea-b671-9ff387d4b394,
--   sem variante): reserved_quantity atual=6. order_items item_kind=product
--   deste produto: 528c37da (MIL-2026-00001085, expired, qty=2 -- orfao),
--   cff81a17 (MIL-2026-00001086, confirmed, qty=2 -- legitimo), 1b32c02e
--   (MIL-2026-00001089, confirmed, qty=2 -- legitimo), d90f7101 (outro
--   pedido, delivered, qty=1). Legitimo=2+2=4, orfao=2 (bate com os 2
--   reportados). delivered_quantity atual=1 bate exatamente com d90f7101 --
--   confirma que SO reserved_quantity tem residuo, delivered_quantity nunca
--   precisou de correcao.
--
--   Copo Termico Logo (store_item_id 3a441dd9-a5c6-4d8a-86fa-9f0aa7db227d,
--   sem variante): reserved_quantity atual=3. order_items: 5156836b
--   (MIL-2026-00001085, expired, qty=1 -- orfao), ea52604c
--   (MIL-2026-00001086, confirmed, qty=1 -- legitimo), 123ba0b7
--   (MIL-2026-00001087, expired, qty=1 -- orfao), 6ed6733f e 2c1e1d5d
--   (outros 2 pedidos, delivered, qty=2 cada). Legitimo=1, orfao=2 (bate
--   com os 2 reportados). delivered_quantity atual=4 bate exatamente com
--   2+2.
--
--   Nenhum store_order_items (loja standalone) referencia nenhum dos dois
--   produtos -- confirmado por consulta read-only, zero linhas.
--
-- FORMULA CANONICA (reserved_quantity esperado por store_item_id+variant_id,
-- nunca "reserved_quantity - N" fixo): soma de quantity de toda linha AINDA
-- reservada e nao consumida, nos dois dominios que legitimamente reservam
-- contra store_item_inventory --
--   order_items (compre-junto): item_kind='product' AND status IN
--     ('reserved','confirmed') -- exclui cancelled/expired/refunded/
--     transferred (nunca reservaram de verdade, ou deixaram de reservar) e
--     delivered (a reserva ja virou delivered_quantity, nao conta mais como
--     reserva).
--   store_order_items (loja standalone): status IN ('reserved','confirmed')
--     -- mesmo raciocinio, vocabulario proprio da tabela (sem expired/
--     refunded no item).
-- Nunca inclui event_kit_item_variant_inventory: item vinculado a kit do
-- evento (store_items.linked_event_kit_item_id) roteia para essa OUTRA
-- tabela desde 20260854000000 -- reserve_store_item_stock/
-- deliver_store_item_stock nunca tocam store_item_inventory pra esses itens,
-- entao esta reconciliacao (escopada a store_item_inventory) nunca precisa
-- nem deve considera-la.
--
-- Funcao reutilizavel (revogada de authenticated/anon -- nunca client-
-- facing, so service_role/migration) em vez de recalculo global: escopo
-- explicito por (store_item_id, variant_id), nunca um loop sobre toda a
-- tabela. Lock (for update) antes de ler/corrigir. So decrementa quando ha
-- excesso comprovado (reserved_quantity > soma legitima); RAISE EXCEPTION
-- se a soma legitima for MAIOR que o valor atual (nunca deveria acontecer --
-- sinal de reserva legitima que este script nao entende, aborta em vez de
-- inflar reserved_quantity as cegas). Idempotente: rodar de novo depois de
-- corrigido encontra soma==reserved_quantity, nao faz UPDATE. Nunca toca
-- delivered_quantity/total_quantity, nunca toca orders/payments/order_items/
-- store_order_items, nunca cria evento de entrega.
begin;

create or replace function public.reconcile_store_item_inventory_reservation(p_store_item_id uuid, p_variant_id uuid)
returns table(inventory_id uuid, previous_reserved integer, corrected_reserved integer, delivered_quantity integer, total_quantity integer)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_row public.store_item_inventory%rowtype;
  v_expected integer;
begin
  select * into v_row from public.store_item_inventory
  where store_item_id = p_store_item_id and variant_id is not distinct from p_variant_id
  for update;
  if not found then
    raise exception 'Nenhuma linha de estoque para store_item_id=% variant_id=%.', p_store_item_id, p_variant_id;
  end if;

  select coalesce(sum(oi.quantity), 0) into v_expected
  from public.order_items oi
  where oi.item_kind = 'product'
    and oi.store_item_id = p_store_item_id
    and oi.store_item_variant_id is not distinct from p_variant_id
    and oi.status in ('reserved', 'confirmed');

  v_expected := v_expected + coalesce((
    select sum(soi.quantity) from public.store_order_items soi
    where soi.store_item_id = p_store_item_id
      and soi.variant_id is not distinct from p_variant_id
      and soi.status in ('reserved', 'confirmed')
  ), 0);

  if v_expected > v_row.reserved_quantity then
    raise exception 'store_item_inventory % (store_item_id=%, variant_id=%): soma de reservas legitimas (%) maior que reserved_quantity atual (%) -- nunca deveria acontecer, abortando para investigacao manual em vez de alterar a reserva.',
      v_row.id, p_store_item_id, p_variant_id, v_expected, v_row.reserved_quantity;
  end if;

  if v_expected < v_row.reserved_quantity then
    update public.store_item_inventory
      set reserved_quantity = v_expected, updated_at = now()
      where id = v_row.id;

    insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
    values('store_item_inventory_reservation_reconciled', 'store_item_inventory', v_row.id, v_row.event_id,
      jsonb_build_object('store_item_id', p_store_item_id, 'variant_id', p_variant_id,
        'previous_reserved_quantity', v_row.reserved_quantity, 'corrected_reserved_quantity', v_expected,
        'orphaned_quantity_removed', v_row.reserved_quantity - v_expected));
  end if;

  return query select v_row.id, v_row.reserved_quantity, v_expected, v_row.delivered_quantity, v_row.total_quantity;
end;
$$;

revoke all on function public.reconcile_store_item_inventory_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reconcile_store_item_inventory_reservation(uuid, uuid) to service_role;

-- Aplicacao escopada as 2 variantes confirmadas pela auditoria -- nunca um
-- loop sobre toda store_item_inventory. Cada chamada e condicional a
-- linha existir (ambiente local/staging sem esses ids especificos de
-- producao -- ex.: apos supabase db reset -- nao deve falhar a migration;
-- em producao, onde as duas linhas existem, ambas rodam normalmente).
do $$
begin
  if exists (select 1 from public.store_item_inventory where store_item_id = '498cd6d5-4b22-44ea-b671-9ff387d4b394'::uuid and variant_id is null) then
    perform public.reconcile_store_item_inventory_reservation('498cd6d5-4b22-44ea-b671-9ff387d4b394'::uuid, null);
  end if;
  if exists (select 1 from public.store_item_inventory where store_item_id = '3a441dd9-a5c6-4d8a-86fa-9f0aa7db227d'::uuid and variant_id is null) then
    perform public.reconcile_store_item_inventory_reservation('3a441dd9-a5c6-4d8a-86fa-9f0aa7db227d'::uuid, null);
  end if;
end $$;

commit;
