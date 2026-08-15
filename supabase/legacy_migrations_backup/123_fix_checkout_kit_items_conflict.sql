-- 123_fix_checkout_kit_items_conflict.sql
-- Corrige o erro "conflito ao criar pedido" (Postgres 42P10: no unique or
-- exclusion constraint matching the ON CONFLICT specification) que acontece
-- hoje em QUALQUER checkout publico de evento com kit_enabled = true.
--
-- Causa: public.create_multi_ticket_order_checkout (a RPC chamada pelo
-- client) e so um wrapper que ajusta estoque temporariamente e delega tudo
-- pra public.create_multi_ticket_order_checkout_legacy -- e essa segunda
-- funcao (confirmada via pg_get_functiondef nesta sessao, nao suposta a
-- partir do historico de migrations) que de fato insere os itens de kit do
-- participante:
--   insert into public.participant_kit_items (...)
--   ...
--   on conflict (participant_id, kit_item_id) do update set ...
-- Mas a 087_ticket_kit_items_operational_ownership.sql dropou o indice unico
-- em (participant_id, kit_item_id) e criou um novo em
-- (order_item_id, kit_item_id) -- confirmado tambem nesta sessao via
-- pg_constraint (constraint participant_kit_items_participant_kit_unique =
-- UNIQUE (order_item_id, kit_item_id)). Nenhuma migration seguinte remendou
-- esse INSERT dentro da _legacy. Toda vez que ele roda, o Postgres nao acha
-- nenhuma constraint que bata com o alvo do ON CONFLICT e derruba a
-- transacao inteira (que ja tinha criado order/order_items/payment/reservas
-- de estoque, tudo desfeito no rollback).
--
-- Igual as migrations 030/041/042/045 que ja remendaram funcoes deste mesmo
-- fluxo de checkout: busca a definicao instalada via pg_get_functiondef,
-- confirma que o trecho alvo existe, troca so o alvo do ON CONFLICT, e
-- reinstala a funcao. Nao reescreve o corpo inteiro (e grande e teve varios
-- remendos dinamicos ao longo do tempo, entao a unica fonte confiavel do
-- corpo atual e o que ja esta instalado no banco).
--
-- Nota: o INSERT no bloco de kit nao preenche order_item_id (segue faltando
-- depois desta correcao), entao o "do update" do ON CONFLICT nunca dispara
-- de fato -- toda linha e sempre uma insercao nova, ja que NULL nunca bate
-- com NULL na checagem de unicidade. Isso e aceitavel para o objetivo desta
-- migration (parar o erro 42P10 que quebra o checkout); uma correcao mais
-- profunda de deduplicacao real de participant_kit_items fica fora de escopo.

do $$
declare
  v_fn_oid oid;
  v_def text;
begin
  v_fn_oid := to_regprocedure('public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text)');

  if v_fn_oid is null then
    raise exception 'Funcao public.create_multi_ticket_order_checkout_legacy nao encontrada com a assinatura esperada.';
  end if;

  select pg_get_functiondef(v_fn_oid)
  into v_def;

  if v_def !~* 'on\s+conflict\s*\(\s*participant_id\s*,\s*kit_item_id\s*\)' then
    raise exception 'Trecho alvo (ON CONFLICT participant_id, kit_item_id) nao encontrado na funcao instalada. Abortando para evitar alteracoes adicionais -- confirme manualmente se esta migration ainda e necessaria.';
  end if;

  v_def := regexp_replace(
    v_def,
    'on\s+conflict\s*\(\s*participant_id\s*,\s*kit_item_id\s*\)',
    'on conflict (order_item_id, kit_item_id)',
    'i'
  );

  execute v_def;
end;
$$;

grant execute on function public.create_multi_ticket_order_checkout_legacy(uuid, uuid, text, integer, text, text, text, text, text, text, date, text, text, text, text, boolean, jsonb, integer, text, text) to authenticated;
