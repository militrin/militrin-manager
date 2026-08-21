-- Backfill determinístico de order_items.pricing_gender pra tickets
-- criados ANTES da migration 46 (coluna nao existia / RPC de criacao ainda
-- nao a populava, ver 20260846000000_persist_and_edit_order_item_pricing_gender.sql).
--
-- Investigacao direta no banco (pedido de reproducao do bug "genero nao
-- preservado"): o item 1 desse pedido tem pricing_gender=null e
-- unit_price=180 (male_price do lote); o item 2 tem pricing_gender='female'
-- e unit_price=150 (female_price do lote) -- MAS o audit_logs confirma que
-- o item 2 tambem nasceu com pricing_gender=null (registro
-- order_item_pricing_gender_changed com previous_pricing_gender=null e
-- previous_unit_price=180, ou seja, ele tambem comecou precificado como
-- "male" e so foi corrigido depois via change_pending_order_item_gender,
-- durante testes manuais da funcionalidade nova). Conclusao confirmada: NAO
-- ha bug de criacao perdendo um pricing_gender ja gravado -- os dois itens
-- desse pedido simplesmente nasceram antes da migration 46 existir, com a
-- coluna inteira null. Isso e exatamente o cenario "pedidos anteriores a
-- migration 46" que esta migration trata.
--
-- Regra de seguranca (nunca inferir quando ambiguo, nunca inferir de
-- shirt_type/shirt_size/titular):
--   1) so toca item_kind='ticket' com pricing_gender ainda null;
--   2) so infere quando o LOTE do item (registration_batches.male_price/
--      female_price, o mesmo already travado no order_item via batch_id)
--      tem os dois precos DIFERENTES entre si -- se male_price=female_price
--      pra aquele lote, preco nenhum prova o genero, fica null;
--   3) so infere quando unit_price bate EXATAMENTE (apos round a 2 casas,
--      mesma precisao de registration_batches) com UM dos dois precos do
--      lote -- nunca "mais proximo de", nunca com tolerancia;
--   4) qualquer item que nao se enquadre nas regras acima (preco nao bate
--      com nenhum, lote sem preco diferenciado, ou batch_id nulo) permanece
--      null -- "nao definido" na UI, nunca adivinhado.
--
-- Pedidos criados DEPOIS da migration 46 nunca precisam deste backfill: a
-- propria create_multi_ticket_order_checkout_legacy ja grava pricing_gender
-- na criacao (ver teste de regressao em
-- tests/order-item-pricing-gender.test.mjs).
begin;

update public.order_items oi
set pricing_gender = 'male', updated_at = now()
from public.registration_batches rb
where oi.batch_id = rb.id
  and oi.item_kind = 'ticket'
  and oi.pricing_gender is null
  and rb.male_price is distinct from rb.female_price
  and round(oi.unit_price, 2) = round(rb.male_price, 2);

update public.order_items oi
set pricing_gender = 'female', updated_at = now()
from public.registration_batches rb
where oi.batch_id = rb.id
  and oi.item_kind = 'ticket'
  and oi.pricing_gender is null
  and rb.male_price is distinct from rb.female_price
  and round(oi.unit_price, 2) = round(rb.female_price, 2);

commit;
