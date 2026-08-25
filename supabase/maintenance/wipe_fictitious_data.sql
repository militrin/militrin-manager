-- ============================================================================
-- LIMPEZA DEFINITIVA DE DADOS FICTICIOS -- Militrin Manager
-- ============================================================================
-- NAO E UMA MIGRATION. Fica fora de supabase/migrations/ de proposito, pra
-- nunca ser aplicada automaticamente por `supabase db push`/`migration up`.
-- E um script de manutencao de execucao unica, manual, via SQL Editor do
-- Supabase (ou psql) logado com um role que enxerga auth.users e ignora RLS
-- (role "postgres"/superuser -- rodar como usuario autenticado comum vai
-- falhar silenciosamente ao esbarrar em RLS antes mesmo de qualquer guard).
--
-- O QUE ESTE SCRIPT FAZ:
--   Remove TODO dado transacional/ficticio (eventos, loja, estoque, pedidos,
--   pagamentos, ingressos, participantes/cadastros, pulseiras, kits
--   entregues, cupons, importacoes, financeiro, auditoria) E TODA IDENTIDADE
--   ficticia em public.* (customer_profiles, organization_members,
--   admin_users, admin_user_permission_overrides, platform_users de
--   qualquer user_id que nao seja o protegido), preservando SOMENTE:
--     - a linha de auth.users da conta h.dogui@gmail.com (nunca tocada por
--       este script, so LIDA pra resolver o user_id -- deletar auth.users
--       nao e seguro via SQL direto; ver delete_fictitious_auth_users.mjs
--       ao lado, que usa a Auth Admin API suportada pelo Supabase);
--     - admin_users, organization_members, customer_profiles,
--       platform_users e admin_user_permission_overrides especificamente da
--       linha dessa conta (todo DELETE nessas tabelas abaixo exclui
--       explicitamente `user_id = v_user_id`);
--     - admin_roles/admin_permissions/admin_role_permissions/
--       platform_settings (seed de sistema -- nenhum DELETE abaixo as toca);
--     - a(s) organizacao(oes) em que essa conta e membro ativo (linha vazia
--       preservada, todo o resto de public.organizations e removido).
--
-- Auditoria de IDENTIDADE feita em 2026-08-22 contra o banco remoto
-- (auth.users + tabelas de identidade) encontrou exatamente 1 organizacao
-- ("Militrin") e 5 contas ficticias junto da protegida -- ver
-- delete_fictitious_auth_users.mjs pra lista completa com e-mail/id de cada
-- uma.
--
-- ============================================================================
-- REVISAO 2026-08-22 (b): AUDITORIA COMPLETA DE FOREIGN KEYS
-- ============================================================================
-- A PRIMEIRA tentativa de rodar este script falhou em producao com:
--   "update or delete on table event_kit_item_variants violates foreign key
--    constraint store_item_variants_linked_event_kit_item_variant_id_fkey"
-- Causa: a FASE 7 tentava apagar event_kit_item_variants ANTES de
-- store_item_variants, mas store_item_variants tem uma FK apontando pra
-- event_kit_item_variants (vinculo canonico entre variante de loja e
-- variante de kit do evento).
--
-- Em vez de corrigir so essa FK, foi feita uma auditoria COMPLETA: as 167
-- foreign keys de TODAS as 66 tabelas originalmente tocadas por este script
-- foram extraidas direto do banco remoto (via o schema OpenAPI que o
-- PostgREST gera a partir de pg_catalog -- fonte viva, nao um dump antigo)
-- e um grafo de dependencia foi construido e ordenado topologicamente
-- (algoritmo de Kahn). Isso encontrou:
--
--   9 outras violacoes de ordem alem da que ja tinha derrubado o script
--   (filho sendo deletado DEPOIS do pai que ele referencia):
--     payments.order_id -> orders.id
--     participant_data_issues.order_item_id -> order_items.id
--     participant_data_issues.ticket_id -> tickets.id
--     store_items.linked_event_kit_item_id -> event_kit_items.id
--     import_batch_rows.matched_participant_id -> participants.id
--     import_batch_rows.registration_contact_id -> registration_contacts.id
--     import_batch_rows.order_item_id -> order_items.id
--     import_batch_rows.ticket_id -> tickets.id
--     coupon_product_scopes.store_item_id -> store_items.id
--
--   1 CICLO real (nao resolvivel so por reordenar): orders.payment_id
--   aponta pra payments.id, E payments.order_id aponta pra orders.id, ao
--   mesmo tempo. Resolvido com um UPDATE que zera orders.payment_id ANTES
--   do DELETE de payments (payment_id e nullable -- confirmado no schema)
--   -- ver FASE 4 abaixo. Nenhuma FK e alterada/removida pra isso, so o
--   VALOR da coluna e zerado temporariamente numa tabela que sera esvaziada
--   de qualquer forma poucas fases depois.
--
--   2 relacoes fora da lista original que a auditoria de FKs (via schema
--   OpenAPI) reportou com referencia PRA DENTRO das tabelas que este script
--   apaga:
--     - admin_user_permission_overrides (permission_id -> admin_permissions;
--       nao tem FK formal pra admin_users, mas e claramente dado de
--       identidade por usuario -- adicionada a FASE 0.5, mesmo padrao
--       `user_id <> v_user_id` das outras 4 tabelas de identidade;
--       0 linhas no momento da auditoria, adicionada por seguranca/futuro).
--       Essa E uma tabela real, com FK real -- risco real de bloquear
--       DELETE, corretamente resolvido colocando-a na FASE 0.5.
--     - confirmed_payments_cash_backfill_111_candidates (participant_id ->
--       participants.id, event_id -> events.id, organization_id ->
--       organizations.id) -- na epoca presumida tabela de diagnostico de
--       uma migration antiga (111_confirmed_payments_cash_backfill.sql).
--       A REVISAO (c) abaixo corrige essa premissa: e uma VIEW, e essas
--       "FKs" reportadas pelo OpenAPI sao inferencia de proveniencia de
--       coluna do PostgREST (ele rastreia que o SELECT da view vem de
--       payments/orders/etc. e herda a FK real DESSAS tabelas so pra fins
--       de embedding da API) -- nunca um pg_constraint de verdade numa
--       view (Postgres nem permite isso). Ou seja: essa relacao NUNCA
--       teve poder de bloquear nenhum DELETE via FK -- o problema real
--       era outro (DELETE direto numa view nao suportada), corrigido na
--       revisao (c).
--
-- ============================================================================
-- REVISAO 2026-08-22 (c): confirmed_payments_cash_backfill_111_candidates E
-- VIEW, NAO TABELA -- FASE 0.6 (b) tentava um DELETE nela e falhou:
--   "cannot delete from view ... Views containing WITH are not
--    automatically updatable."
-- Causa: apesar do nome (parece tabela de "candidatos"), essa relacao e uma
-- VIEW (CREATE OR REPLACE VIEW, com uma CTE "WITH" -- por isso Postgres nem
-- tenta o auto-INSTEAD OF automatico que views simples ganham). DELETE
-- nunca poderia funcionar nela.
--
-- Pra nao repetir esse erro, TODAS as 68 relacoes originalmente tocadas
-- pelo script (as 66 da auditoria de FKs da revisao (b) + esta view + a
-- tabela admin_user_permission_overrides tambem adicionada na (b)) foram
-- reclassificadas via 2 fontes independentes, ambas contra o estado ATUAL
-- do banco remoto (nao um dump antigo):
--   1. Historico de DDL em supabase/migrations/*.sql: qual comando criou
--      cada relacao (CREATE TABLE vs CREATE [OR REPLACE] VIEW vs CREATE
--      MATERIALIZED VIEW).
--   2. Schema OpenAPI que o PostgREST gera ao vivo a partir de pg_catalog:
--      relacoes que sao VIEW aparecem sem a lista `required` (colunas NOT
--      NULL sem default) que toda TABLE real tem -- um sinal independente,
--      direto do banco, sem depender do historico de migrations estar
--      100% sincronizado com o estado real.
-- As 2 fontes bateram exatamente: das 68 relacoes, 67 sao TABLE de verdade
-- e exatamente 1 (confirmed_payments_cash_backfill_111_candidates) e VIEW.
-- ZERO materialized views em toda a base (nenhuma ocorrencia de "CREATE
-- MATERIALIZED VIEW" em nenhuma migration).
--
-- A view depende de 3 tabelas-base (visiveis no proprio CREATE VIEW, ver
-- migration 20260815001914_remote_schema.sql linha ~14962): public.payments
-- (fonte principal -- id/participant_id/event_id/organization_id/etc. vem
-- todos de "pay", o apelido de payments), public.orders e public.order_items
-- (usadas so pra classificar/contar vinculos, via LEFT/INNER JOIN). As 3 ja
-- sao esvaziadas por este proprio script (FASE 4, FASE 11, FASE 12) --
-- entao a view fica vazia SOZINHA, sem nenhum DELETE nela ser necessario ou
-- possivel. O DELETE da FASE 0.6 (b) foi REMOVIDO por completo; a unica
-- mencao que resta a essa view agora e na FASE 21 (validacao pos-limpeza),
-- que so faz `select count(*)` -- uma view suporta SELECT normalmente,
-- so nao suporta DELETE/UPDATE direto por causa da CTE.
--
-- A ordem completa abaixo (FASE 0.5 a FASE 19) foi reconstruida a partir do
-- resultado do algoritmo topologico e reverificada programaticamente:
-- as 167 FKs originais (menos a quebrada deliberadamente pelo UPDATE) tem
-- ZERO violacoes na ordem final. Onde o agrupamento por FASE nao bate mais
-- com o agrupamento tematico antigo (ex.: tickets/order_items/orders agora
-- so podem ser apagados DEPOIS de import_batch_rows, porque
-- import_batch_rows.ticket_id/order_item_id apontam pra eles), ha um
-- comentario explicando o motivo especifico no ponto da mudanca.
--
-- GUARDS: a FASE 0 aborta (RAISE EXCEPTION => ROLLBACK automatico de toda a
-- transacao) se a conta nao existir, existir mais de uma vez, ou nao tiver
-- organizacao/admin ativo ANTES de qualquer DELETE. A FASE FINAL revalida
-- tudo de novo DEPOIS dos deletes -- inclusive que sobrou EXATAMENTE 1
-- linha em cada uma das 5 tabelas de identidade, a da conta protegida -- e
-- aborta (mesmo efeito) se qualquer coisa protegida tiver mudado. Nenhum
-- commit acontece se qualquer guard falhar -- uma excecao nao tratada
-- dentro do DO $$ propaga e invalida a transacao inteira; o COMMIT final
-- vira um no-op sobre uma transacao ja abortada.
--
-- Nao usa TRUNCATE (indiscriminado ou CASCADE) em nenhum momento -- todo
-- DELETE abaixo respeita a ordem de dependencia entre FKs (auditada e
-- verificada programaticamente, ver acima) e roda sujeito aos triggers
-- normais da tabela. Nenhuma estrutura (tabela/coluna/constraint), role ou
-- a organizacao minima protegida e removida -- so linhas de dado.
--
-- PARA ENSAIAR SEM COMMITAR: troque a ultima linha `commit;` por
-- `rollback;` -- os RAISE NOTICE abaixo ainda mostram o que teria
-- acontecido, mas nada fica gravado.
-- ============================================================================

begin;

do $$
declare
  v_email text := 'h.dogui@gmail.com';
  v_user_id uuid;
  v_org_ids uuid[];
  v_admin_row public.admin_users%rowtype;
  v_member_count_before int;
  v_customer_profile_before boolean;
  v_platform_user_before boolean;
  v_deleted_orgs int;
  v_final_member_count int;
  v_final_admin_active boolean;
  v_final_customer_profile boolean;
  v_final_platform_user boolean;
  v_remaining_orgs int;
  v_leftover_count bigint;
  v_deleted_customer_profiles int;
  v_deleted_org_members int;
  v_deleted_admin_users int;
  v_deleted_platform_users int;
  v_deleted_permission_overrides int;
  v_final_identity_count bigint;
begin
  raise notice '=== FASE 0: identificacao e guarda da conta protegida (%): ===', v_email;

  -- "select ... into strict" ja aborta sozinho (no_data_found/too_many_rows)
  -- se nao existir exatamente 1 linha -- satisfaz "abortar se nao encontrar
  -- exatamente uma conta" sem checagem manual de count.
  select id into strict v_user_id from auth.users where email = v_email;

  select array_agg(organization_id) into v_org_ids
  from public.organization_members
  where user_id = v_user_id and is_active = true;

  if v_org_ids is null or array_length(v_org_ids, 1) is null then
    raise exception 'ABORT: % nao tem nenhuma organization_members ativa -- impossivel preservar "organizacao minima" sem isso.', v_email;
  end if;

  select * into v_admin_row from public.admin_users where user_id = v_user_id;
  if not found or not v_admin_row.is_active then
    raise exception 'ABORT: % nao tem admin_users ativo -- acesso administrativo ja nao esta garantido antes de tocar em qualquer dado.', v_email;
  end if;

  select count(*) into v_member_count_before from public.organization_members where user_id = v_user_id;
  select exists(select 1 from public.customer_profiles where user_id = v_user_id) into v_customer_profile_before;
  select exists(select 1 from public.platform_users where user_id = v_user_id) into v_platform_user_before;

  raise notice 'Conta protegida OK: user_id=%, organizacoes preservadas=%, admin_users.role_id=%, memberships=%, customer_profile=%, platform_user=%',
    v_user_id, v_org_ids, v_admin_row.role_id, v_member_count_before, v_customer_profile_before, v_platform_user_before;

  -- ============================================================
  -- FASE 0.5: identidade ficticia em public.* -- toda linha dessas 5
  -- tabelas que NAO pertence a conta protegida. Cada DELETE exclui
  -- explicitamente `user_id = v_user_id` por construcao: mesmo que
  -- v_user_id estivesse errado por algum bug acima, estas linhas nunca
  -- poderiam casar com a propria conta protegida.
  --
  -- admin_user_permission_overrides adicionada nesta revisao: nao tem FK
  -- formal pra admin_users, mas e dado de excecao de permissao POR usuario
  -- -- mesma familia logica das outras 4, mesmo guard `user_id <>
  -- v_user_id`. Sua unica FK real e pra admin_permissions (seed
  -- preservado), entao nao ha risco de ordem aqui.
  --
  -- Nao apaga auth.users em si (ver delete_fictitious_auth_users.mjs) --
  -- mas ja que admin_users/organization_members/customer_profiles/
  -- platform_users tem FK ON DELETE CASCADE pra auth.users, rodar aquele
  -- script primeiro (recomendado) ja deixa essas tabelas vazias por
  -- cascata e os DELETEs abaixo simplesmente nao encontram nada pra
  -- apagar (nao e erro, e idempotente rodar os dois em qualquer ordem).
  -- ============================================================
  raise notice '=== FASE 0.5: identidade ficticia (customer_profiles/organization_members/admin_users/admin_user_permission_overrides/platform_users) ===';

  delete from public.customer_profiles where user_id <> v_user_id;
  get diagnostics v_deleted_customer_profiles = row_count;

  delete from public.organization_members where user_id <> v_user_id;
  get diagnostics v_deleted_org_members = row_count;

  delete from public.admin_user_permission_overrides where user_id <> v_user_id;
  get diagnostics v_deleted_permission_overrides = row_count;

  delete from public.admin_users where user_id <> v_user_id;
  get diagnostics v_deleted_admin_users = row_count;

  delete from public.platform_users where user_id <> v_user_id;
  get diagnostics v_deleted_platform_users = row_count;

  raise notice 'Identidades ficticias removidas: customer_profiles=%, organization_members=%, admin_user_permission_overrides=%, admin_users=%, platform_users=%',
    v_deleted_customer_profiles, v_deleted_org_members, v_deleted_permission_overrides, v_deleted_admin_users, v_deleted_platform_users;

  -- ============================================================
  -- SEM FASE 0.6: confirmed_payments_cash_backfill_111_candidates e VIEW
  -- (nao tabela -- ver REVISAO (c) no cabecalho), derivada de payments/
  -- orders/order_items via uma CTE "WITH", entao Postgres nao permite
  -- DELETE nela (nem auto-INSTEAD OF, nem manual sem definir uma regra
  -- propria -- o que este script nunca faria so pra uma view de
  -- diagnostico). Nenhuma acao e necessaria ou possivel aqui: assim que
  -- payments (FASE 4), order_items (FASE 11) e orders (FASE 12) forem
  -- esvaziadas, a view fica vazia sozinha. A unica mencao que resta a ela
  -- e a validacao read-only na FASE 21 (validacao pos-limpeza), abaixo.
  -- ============================================================

  -- ============================================================
  -- FASE 1: financeiro -- financial_entries referencia orders/participants
  -- (source_order_id/source_participant_id) SEM cascade; sai cedo, antes
  -- de qualquer coisa que dependa dela ser tocada (nada depende dela: e
  -- sempre filha, nunca pai, nesta cadeia).
  -- ============================================================
  raise notice '=== FASE 1: financeiro ===';
  delete from public.financial_entry_lines;
  delete from public.financial_entry_settlements;
  delete from public.financial_reconciliations;
  delete from public.financial_reversals;
  delete from public.financial_event_allocations;
  delete from public.financial_entries;
  delete from public.financial_suppliers;
  delete from public.financial_accounts;
  delete from public.financial_categories;

  -- ============================================================
  -- FASE 2: auditoria e vinculos presos ao ticket
  -- ============================================================
  raise notice '=== FASE 2: auditoria/vinculos de ticket ===';
  delete from public.ticket_item_change_requests;
  delete from public.ticket_holder_history;
  delete from public.ticket_owner_history;
  delete from public.participant_wristbands;
  delete from public.participant_kit_items;
  delete from public.kit_deliveries;
  delete from public.inventory_movements;

  -- ============================================================
  -- FASE 3: descontos de item e resgates de cupom presos a order_items --
  -- SO os vinculos, nao order_items em si (que so pode sair depois de
  -- tickets/import_batch_rows, ver FASE 11).
  -- ============================================================
  raise notice '=== FASE 3: descontos/resgates presos a linha de pedido ===';
  delete from public.order_item_discounts;
  delete from public.store_order_items;
  delete from public.coupon_redemptions;

  -- ============================================================
  -- FASE 4: pedidos de loja e pagamentos -- orders (ingressos) NAO sai
  -- aqui: tickets.order_id e payments.order_id apontam pra orders, entao
  -- orders so pode ser apagada depois de tickets (FASE 12) e payments
  -- (agora). O UPDATE abaixo quebra o CICLO real orders<->payments
  -- (orders.payment_id -> payments.id, ao mesmo tempo que payments.order_id
  -- -> orders.id): zera o ponteiro "pagamento atual" antes de apagar
  -- payments, sem tocar em nenhuma FK/estrutura -- so o valor da coluna,
  -- numa tabela (orders) que ainda nem foi apagada (isso so acontece na
  -- FASE 13).
  -- ============================================================
  raise notice '=== FASE 4: pedidos de loja e pagamentos ===';
  delete from public.store_orders;
  update public.orders set payment_id = null where payment_id is not null;
  delete from public.payments;

  -- ============================================================
  -- FASE 5: pendencias, convites e historico de participacao presos a
  -- participant/registration_contact (mas participants/registration_contacts
  -- em si so saem na FASE 13).
  -- ============================================================
  raise notice '=== FASE 5: pendencias/convites/historico de participacao ===';
  delete from public.participant_data_issues;
  delete from public.participant_account_invites;
  delete from public.participation_history;

  -- ============================================================
  -- FASE 6: estoque fisico -- as 3 tabelas de inventario/imagem que nao
  -- tem nenhuma FK de saida bloqueante (so recebem referencia, nunca
  -- apontam pra fora). shirt_inventory idem.
  -- ============================================================
  raise notice '=== FASE 6: estoque fisico ===';
  delete from public.event_kit_item_variant_inventory;
  delete from public.store_item_inventory;
  delete from public.store_item_images;
  delete from public.shirt_inventory;

  -- ============================================================
  -- FASE 7: escopos de cupom -- precisam sair ANTES de store_items (FASE
  -- 15) e de coupons (FASE 16), que ambos referenciam.
  -- coupon_product_scopes.store_item_id -> store_items.id era uma das
  -- violacoes encontradas na auditoria (store_items saia antes na versao
  -- anterior do script).
  -- ============================================================
  raise notice '=== FASE 7: escopos de cupom ===';
  delete from public.coupon_event_scopes;
  delete from public.coupon_ticket_category_scopes;
  delete from public.coupon_product_scopes;

  -- ============================================================
  -- FASE 8: catalogo/config de evento (parte 1) -- tudo que nao e
  -- registration_batches/ticket_categories em si (que saem so na FASE 16,
  -- depois de order_items/participants terem sido removidos).
  -- ============================================================
  raise notice '=== FASE 8: catalogo/config de evento (parte 1) ===';
  delete from public.registration_batch_prices;
  delete from public.registration_batch_addons;
  delete from public.event_batch_addon_options;
  delete from public.ticket_category_benefits;
  delete from public.event_addon_options;
  delete from public.event_addons_config;
  delete from public.event_addons_model;
  delete from public.event_attractions;
  delete from public.event_highlights;
  delete from public.event_payment_methods;
  delete from public.kit_delivery_schedule;

  -- ============================================================
  -- FASE 9 [MOVIDA -- era FASE 10 "importacoes"]: import_batch_rows tem FK
  -- pra tickets.id, order_items.id, participants.id (matched_participant_id)
  -- e registration_contacts.id -- as 4 eram violacoes encontradas na
  -- auditoria (import_batch_rows saia MUITO depois dessas 4 tabelas na
  -- versao anterior). Precisa sair ANTES de todas elas. import_batches (o
  -- cabecalho do lote) continua mais pra frente, na FASE 17 -- orders
  -- referencia import_batches, entao o cabecalho so pode sair depois de
  -- orders.
  -- ============================================================
  raise notice '=== FASE 9: linhas de importacao (import_batch_rows) ===';
  delete from public.import_batch_rows;

  -- ============================================================
  -- FASE 10: ingressos -- so pode sair depois de import_batch_rows (FASE 9)
  -- e ANTES de order_items/orders/participants, que tickets referencia.
  -- ============================================================
  raise notice '=== FASE 10: tickets ===';
  delete from public.tickets;

  -- ============================================================
  -- FASE 11: linhas de pedido (ingresso) -- so pode sair depois de tickets
  -- (tickets.order_item_id aponta pra ca) e ANTES de orders/participants/
  -- registration_contacts, que order_items referencia.
  -- ============================================================
  raise notice '=== FASE 11: linhas de pedido (order_items) ===';
  delete from public.order_items;

  -- ============================================================
  -- FASE 12: pedidos (ingresso) -- so pode sair depois de tickets/
  -- order_items (que apontam pra ca) e depois do UPDATE da FASE 4 ja ter
  -- zerado orders.payment_id. Ainda ANTES de participants (orders.
  -- participant_id), import_batches (orders.import_batch_id) e coupons
  -- (orders.applied_coupon_id), que orders referencia.
  -- ============================================================
  raise notice '=== FASE 12: pedidos (orders) ===';
  delete from public.orders;

  -- ============================================================
  -- FASE 13: participantes/cadastros -- so depois de TUDO que referencia
  -- participant_id/registration_contact_id (tickets, order_items, orders,
  -- payments, financial_entries, import_batch_rows, participant_wristbands,
  -- participant_kit_items etc. -- todos ja removidos nas fases anteriores).
  -- ============================================================
  raise notice '=== FASE 13: participantes/cadastros ===';
  delete from public.participants;
  delete from public.registration_contacts;

  -- ============================================================
  -- FASE 14: variantes de item -- store_item_variants tem FK pra
  -- event_kit_item_variants (linked_event_kit_item_variant_id) ALEM de pra
  -- store_items -- essa era a FK que derrubou a 1a tentativa do script
  -- (event_kit_item_variants saia antes de store_item_variants). Ordem
  -- corrigida: store_item_variants sempre antes de event_kit_item_variants.
  -- ============================================================
  raise notice '=== FASE 14: variantes de item (store_item_variants / event_kit_item_variants) ===';
  delete from public.store_item_variants;
  delete from public.event_kit_item_variants;

  -- ============================================================
  -- FASE 15: itens -- store_items tem FK pra event_kit_items
  -- (linked_event_kit_item_id, vinculo canonico camiseta-do-ingresso <->
  -- item de loja) -- outra violacao encontrada na auditoria (event_kit_items
  -- saia antes de store_items). Ordem corrigida: store_items sempre antes
  -- de event_kit_items.
  -- ============================================================
  raise notice '=== FASE 15: itens (store_items / event_kit_items) ===';
  delete from public.store_items;
  delete from public.event_kit_items;

  -- ============================================================
  -- FASE 16: cupons e catalogo/config de evento (parte 2) -- coupons so
  -- pode sair depois de orders (orders.applied_coupon_id) e dos escopos de
  -- cupom (FASE 7). registration_batches/ticket_categories so podem sair
  -- depois de participants/order_items (que os referenciam via batch_id/
  -- ticket_category_id).
  -- ============================================================
  raise notice '=== FASE 16: cupons e catalogo/config de evento (parte 2) ===';
  delete from public.coupons;
  delete from public.registration_batches;
  delete from public.ticket_categories;

  -- ============================================================
  -- FASE 17: importacoes (cabecalho do lote) -- import_batches so pode
  -- sair depois de orders (orders.import_batch_id) e de import_batch_rows
  -- (ja removida na FASE 9).
  -- ============================================================
  raise notice '=== FASE 17: importacoes (import_batches) ===';
  delete from public.import_batches;

  -- ============================================================
  -- FASE 18: extras (patrocinadores, feedback, rate-limit de PIN, logs)
  -- ============================================================
  raise notice '=== FASE 18: extras ===';
  delete from public.sponsors;
  delete from public.user_feedback;
  delete from public.user_pin_lookup_attempts;
  delete from public.audit_logs;

  -- ============================================================
  -- FASE 19: eventos -- por ultimo entre os dados transacionais: e o pai
  -- de praticamente tudo (orders, participants, tickets, payments,
  -- registration_batches, ticket_categories, import_batches, coupons etc.
  -- -- todos ja removidos nas fases anteriores. A view
  -- confirmed_payments_cash_backfill_111_candidates ja esta vazia desde a
  -- FASE 12 (depende so de payments/orders/order_items, sem DELETE proprio
  -- -- ver nota logo apos a FASE 0.5).
  -- ============================================================
  raise notice '=== FASE 19: eventos ===';
  delete from public.events;

  -- ============================================================
  -- FASE 20: organizacoes -- preserva SO as vinculadas a conta protegida
  -- ============================================================
  raise notice '=== FASE 20: organizacoes ===';
  delete from public.organizations
  where id <> all(v_org_ids);
  get diagnostics v_deleted_orgs = row_count;
  raise notice 'Organizacoes removidas: %. Organizacoes preservadas (vazias): %.', v_deleted_orgs, v_org_ids;

  -- ============================================================
  -- FASE 21: VALIDACAO POS-LIMPEZA -- qualquer falha aqui aborta a
  -- transacao inteira (nada e commitado, tudo volta ao estado anterior).
  -- ============================================================
  raise notice '=== FASE 21: validacao pos-limpeza ===';

  if not exists(select 1 from auth.users where id = v_user_id and email = v_email) then
    raise exception 'GUARD FALHOU: auth.users da conta protegida sumiu ou o email mudou.';
  end if;

  select is_active into v_final_admin_active from public.admin_users where user_id = v_user_id;
  if v_final_admin_active is distinct from true then
    raise exception 'GUARD FALHOU: admin_users da conta protegida nao esta mais ativo/presente.';
  end if;

  select count(*) into v_final_member_count from public.organization_members where user_id = v_user_id;
  if v_final_member_count <> v_member_count_before or v_final_member_count = 0 then
    raise exception 'GUARD FALHOU: organization_members da conta protegida mudou (antes=%, depois=%).', v_member_count_before, v_final_member_count;
  end if;

  select exists(select 1 from public.customer_profiles where user_id = v_user_id) into v_final_customer_profile;
  if v_final_customer_profile is distinct from v_customer_profile_before then
    raise exception 'GUARD FALHOU: customer_profiles da conta protegida mudou.';
  end if;

  select exists(select 1 from public.platform_users where user_id = v_user_id) into v_final_platform_user;
  if v_final_platform_user is distinct from v_platform_user_before then
    raise exception 'GUARD FALHOU: platform_users da conta protegida mudou.';
  end if;

  select count(*) into v_remaining_orgs from public.organizations where id <> all(v_org_ids);
  if v_remaining_orgs <> 0 then
    raise exception 'GUARD FALHOU: sobraram % organizacoes fora da lista protegida.', v_remaining_orgs;
  end if;

  select count(*) into v_remaining_orgs from public.organizations where id = any(v_org_ids);
  if v_remaining_orgs <> array_length(v_org_ids, 1) then
    raise exception 'GUARD FALHOU: a(s) organizacao(oes) protegida(s) nao sobreviveram intactas.';
  end if;

  -- Nenhuma linha de identidade fora da conta protegida pode ter sobrevivido
  -- (a mesma condicao usada nos DELETEs da FASE 0.5, revalidada aqui).
  select
    (select count(*) from public.customer_profiles where user_id <> v_user_id) +
    (select count(*) from public.organization_members where user_id <> v_user_id) +
    (select count(*) from public.admin_user_permission_overrides where user_id <> v_user_id) +
    (select count(*) from public.admin_users where user_id <> v_user_id) +
    (select count(*) from public.platform_users where user_id <> v_user_id)
  into v_final_identity_count;

  if v_final_identity_count <> 0 then
    raise exception 'GUARD FALHOU: sobraram % linha(s) de identidade ficticia (customer_profiles/organization_members/admin_user_permission_overrides/admin_users/platform_users) fora da conta protegida.', v_final_identity_count;
  end if;

  -- Confere que os principais focos de dado ficticio realmente esvaziaram.
  -- A ultima linha e a UNICA mencao a confirmed_payments_cash_backfill_111_
  -- candidates no script inteiro (e uma VIEW, nunca recebe DELETE -- ver
  -- nota apos a FASE 0.5): so um SELECT COUNT read-only, que precisa dar 0
  -- depois que payments/orders/order_items (suas tabelas-base) esvaziarem.
  select
    (select count(*) from public.events) +
    (select count(*) from public.tickets) +
    (select count(*) from public.orders) +
    (select count(*) from public.store_orders) +
    (select count(*) from public.payments) +
    (select count(*) from public.store_items) +
    (select count(*) from public.participants) +
    (select count(*) from public.participant_wristbands) +
    (select count(*) from public.coupons) +
    (select count(*) from public.import_batches) +
    (select count(*) from public.confirmed_payments_cash_backfill_111_candidates)
  into v_leftover_count;

  if v_leftover_count <> 0 then
    raise exception 'GUARD FALHOU: ainda ha % linha(s) residual(is) em tabelas que deveriam estar vazias.', v_leftover_count;
  end if;

  raise notice '=== TUDO OK: conta protegida intacta, dados ficticios removidos. ===';
end $$;

-- Se o DO $$ acima levantou qualquer excecao, a transacao ja esta abortada
-- e este COMMIT nao grava nada (Postgres recusa commitar transacao em
-- estado de erro). Troque por `rollback;` pra ensaiar sem gravar de jeito
-- nenhum, mesmo se todos os guards passarem.
commit;
