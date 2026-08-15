-- 123_fix_checkout_kit_items_conflict_preflight.sql
-- Somente leitura. Confirma, antes de aplicar a 123, que:
--   1) a funcao instalada de create_multi_ticket_order_checkout_legacy (a
--      funcao que de fato insere os itens de kit -- create_multi_ticket_order_checkout
--      e so um wrapper que ajusta estoque e delega pra ela) ainda tem o
--      ON CONFLICT antigo, desatualizado desde a 087 (isso e o que causa o
--      erro "conflito ao criar pedido" em eventos com kit habilitado);
--   2) a constraint unica esperada em participant_kit_items, criada pela 087,
--      realmente existe em (order_item_id, kit_item_id) e nao mais em
--      (participant_id, kit_item_id).
-- Nao envia nada, nao altera dados.

select
  to_regprocedure(
    'public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)'
  ) is not null as function_found;
-- esperado: true

select
  (pg_get_functiondef(to_regprocedure(
    'public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)'
  )) ilike '%on conflict (participant_id, kit_item_id)%') as has_stale_conflict_target,
  (pg_get_functiondef(to_regprocedure(
    'public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)'
  )) ilike '%on conflict (order_item_id, kit_item_id)%') as already_has_new_conflict_target;
-- esperado: has_stale_conflict_target = true, already_has_new_conflict_target = false
-- (se already_has_new_conflict_target ja for true, a 123 nao precisa mais ser aplicada)

select
  (
    length(pg_get_functiondef(to_regprocedure(
      'public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)'
    ))) -
    length(replace(pg_get_functiondef(to_regprocedure(
      'public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)'
    )), 'on conflict (participant_id, kit_item_id)', ''))
  ) / length('on conflict (participant_id, kit_item_id)') as stale_conflict_target_occurrences;
-- esperado: 1 (uma unica ocorrencia, pra garantir que o replace pontual da 123 acerta so o lugar certo)

select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.participant_kit_items'::regclass
  and contype = 'u';
-- esperado: uma constraint unica cuja definicao e UNIQUE (order_item_id, kit_item_id)
-- (criada pela 087_ticket_kit_items_operational_ownership.sql) -- NAO deve existir
-- mais nenhuma unique constraint em (participant_id, kit_item_id) nesta tabela.
