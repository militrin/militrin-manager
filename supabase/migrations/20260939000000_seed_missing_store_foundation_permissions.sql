-- FIX (achado durante os testes de integracao da feature de QR de retirada,
-- sessao anterior): store.view, store.manage e store.deliver nunca sao
-- inseridas por nenhuma migration em supabase/migrations/ -- a semeadura
-- original vive so em supabase/legacy_migrations_backup/116_store_module_
-- foundation.sql (com nome/descricao revisados depois em
-- 117_store_item_images.sql), pasta que NUNCA e aplicada por `supabase db
-- reset` (so as migrations em supabase/migrations/ sao). Confirmado por
-- consulta direta: um `db reset` do zero deixa a tabela admin_permissions
-- SEM essas 3 linhas -- toda RPC que checa current_user_has_permission
--('store.deliver'/'store.manage'/'store.view') sempre retorna false pra
-- qualquer usuario nao-owner nesse cenario (resolve_user_permission
-- retorna false direto quando o codigo nao existe no catalogo, antes mesmo
-- de checar papel/override do usuario). Isso ficava mascarado em qualquer
-- fluxo testado so com o papel 'owner' (que ignora essa checagem via
-- bypass proprio, ja existente, documentado em resolve_user_permission) --
-- so ficou visivel testando um papel comum de verdade.
--
-- Revisado o historico completo de supabase/legacy_migrations_backup/ pra
-- garantir que nenhuma OUTRA permissao do modulo "store" tem o mesmo gap:
-- store.grant_items (20260858000000) e store.undo_delivery (20260932000000
-- desta propria feature) ja tem migration canonica correspondente -- so
-- estas 3 (as fundacionais, da migration 116 original) estavam faltando.
--
-- Correcao minima, idempotente e isolada: so garante a EXISTENCIA das 3
-- linhas no catalogo admin_permissions, com o modelo vigente exato (nome/
-- descricao da revisao mais recente encontrada, 117_store_item_images.sql;
-- module/sort_order/is_active de 116, nunca revisados depois). ON CONFLICT
-- (code) -- coerente com a UNIQUE constraint real da tabela
-- (admin_permissions_code_key, ja confirmada). Nao mexe em
-- admin_role_permissions nem admin_user_permission_overrides: nenhuma
-- atribuicao de usuario/papel existente muda, e nenhum bypass novo e
-- criado -- so o catalogo passa a existir, pra current_user_has_permission
-- voltar a decidir com base no papel/override real de cada usuario (que ja
-- e como o resto do sistema sempre funcionou). RLS nao e tocada aqui.
begin;

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values
  ('store.view', 'Ver loja do evento', 'Visualiza catalogo, estoque e pedidos da loja do evento', 'store', 10, true),
  ('store.manage', 'Gerenciar loja do evento', 'Cria/edita itens, variantes e estoque da loja do evento', 'store', 20, true),
  ('store.deliver', 'Entregar itens da loja', 'Registra entrega/desfazer entrega de itens comprados na loja do evento', 'store', 30, true)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  module = excluded.module,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

commit;
