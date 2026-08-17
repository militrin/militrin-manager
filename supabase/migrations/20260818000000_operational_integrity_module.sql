-- NEXORA/Militrin: Central de Integridade Operacional (V1).
--
-- Arquitetura (ver auditoria completa no relatorio da tarefa): nenhuma
-- funcao existente agrega multiplas subconsultas heterogeneas numa unica
-- RPC (o padrao hoje e agregacao em TS, ex. loadAdminDashboard). Para esta
-- Central, uma unica fonte de verdade por regra e essencial (usada por
-- Dashboard, Central de Operacoes, Retirada, fichas, relatorios e o futuro
-- pre-flight check) e o volume de detectores heterogeneos torna isso mais
-- natural em SQL do que em N chamadas TS. Escolha:
--
-- 1) Um tipo composto `integrity_issue_row` -- o contrato central estavel.
-- 2) Uma funcao POR detector (`detect_integrity_*`), cada uma a UNICA fonte
--    de verdade daquela regra, retornando uma linha por ENTIDADE afetada
--    (nunca pre-agregada) -- testavel isoladamente via service_role.
-- 3) Uma RPC agregadora (`get_operational_integrity_report`) que faz UNION
--    ALL de todos os detectores e agrupa por (code,event_id) para o resumo
--    -- um unico round-trip do browser, sem N+1.
-- 4) Uma RPC de detalhe (`get_operational_integrity_issue_entities`) que
--    reusa OS MESMOS detectores, sem agrupar, para o drawer "Ver N registros".
--
-- Autorizacao: organization_id NUNCA vem do client -- resolvido sempre via
-- current_organization_id() (mesma convencao de sponsors/feedback). event_id
-- enviado pelo client e validado contra essa organizacao antes de qualquer
-- uso. As funcoes de detector individuais sao security definer mas SEM
-- grant para authenticated/anon -- so a RPC agregadora/detalhe (que fazem a
-- checagem de permissao e organizacao) e o service_role (para testes de
-- integracao isolados por detector) podem chama-las.
begin;

-- ============================================================
-- 1. Contrato central
-- ============================================================

drop type if exists public.integrity_issue_row cascade;
create type public.integrity_issue_row as (
  code text,
  severity text,          -- 'critical' | 'attention' | 'warning'
  domain text,             -- 'titularidade' | 'ingressos_pedidos' | 'categoria_preco' | 'camisetas_kits' | 'estoque' | 'checkin_retirada' | 'cadastros' | 'configuracao_evento'
  title text,
  description text,
  event_id uuid,
  entity_type text,
  entity_id uuid,
  action_label text,
  action_href text,
  metadata jsonb
);

-- ============================================================
-- 2. Permissao (mesmo padrao de sponsors.view/feedback.view). So "view":
--    a Central nao altera dados diretamente -- toda resolucao usa as
--    permissoes/RPCs ja existentes das paginas de destino (ex.: abrir um
--    ingresso e editar titular continua exigindo participants.edit_basic).
-- ============================================================

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values ('integrity.view', 'Ver integridade operacional', 'Visualiza a central de integridade operacional (diagnosticos de inconsistencia)', 'integrity', 10, true)
on conflict (code) do update set name = excluded.name, description = excluded.description, module = excluded.module, sort_order = excluded.sort_order, is_active = excluded.is_active;

insert into public.admin_role_permissions (role_id, permission_id)
select ar.id, ap.id from public.admin_roles ar join public.admin_permissions ap on ap.code = 'integrity.view'
where ar.code = 'administrator'
on conflict (role_id, permission_id) do nothing;

-- ============================================================
-- 3. Detectores -- Titularidade
-- ============================================================

-- A1. Reusa o mecanismo ja existente de pendencias (participant_data_issues):
-- materialize_named_checkout_holders ja grava 'insufficient_named_holder_identity'
-- exatamente quando um nome foi informado no checkout mas nao havia dados
-- suficientes (CPF valido, ou e-mail+telefone) para resolver/criar o
-- registration_contacts -- ou seja, e a evidencia real de "deveria existir
-- titular". Ingresso comprado para terceiro e ainda nao nomeado (sem essa
-- pendencia) nunca aparece aqui -- estado valido, nao e erro.
create or replace function public.detect_integrity_named_without_holder(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_NAMED_WITHOUT_CANONICAL_HOLDER'::text,
    'attention'::text,
    'titularidade'::text,
    'Titular incompleto'::text,
    'O ingresso possui um nome informado, mas ainda não está corretamente vinculado a uma pessoa.'::text,
    pdi.event_id,
    'order_item'::text,
    pdi.order_item_id,
    'Definir titular'::text,
    case when t.id is not null then '/ingressos/' || t.id || '/editar' else '/ingressos' end,
    jsonb_build_object('issue_id', pdi.id, 'order_item_id', pdi.order_item_id, 'field_code', pdi.field_code)
  from public.participant_data_issues pdi
  join public.events e on e.id = pdi.event_id
  left join public.tickets t on t.order_item_id = pdi.order_item_id and t.status <> 'cancelled'
  where e.organization_id = p_organization_id
    and (p_event_id is null or pdi.event_id = p_event_id)
    and pdi.status = 'open'
    and pdi.issue_type = 'insufficient_named_holder_identity'
    and pdi.order_item_id is not null;
$$;
revoke all on function public.detect_integrity_named_without_holder(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_named_without_holder(uuid, uuid) to service_role;

-- A2. Mesma definicao canonica ja usada em runtime por
-- registration_contact_has_active_ticket/assert_ticket_holder_contact_available:
-- chave de dedupe = coalesce(order_items.registration_contact_id,
-- participants.registration_contact_id); "ativo" = status fora de
-- ('cancelled','canceled','void','voided') (so 'cancelled' existe hoje pelo
-- CHECK de tickets, mas mantemos a mesma lista por consistencia com o
-- runtime). Uma linha por ingresso envolvido no conflito (nao pre-agregado).
create or replace function public.detect_integrity_duplicate_active_holder(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  with active_holders as (
    select
      coalesce(oi.registration_contact_id, p.registration_contact_id) as contact_id,
      t.event_id, t.id as ticket_id
    from public.tickets t
    join public.order_items oi on oi.id = t.order_item_id
    left join public.participants p on p.id = coalesce(oi.participant_id, t.participant_id)
    where t.status not in ('cancelled', 'canceled', 'void', 'voided')
      and coalesce(oi.registration_contact_id, p.registration_contact_id) is not null
      and t.organization_id = p_organization_id
      and (p_event_id is null or t.event_id = p_event_id)
  ),
  conflicts as (
    select contact_id, event_id, count(*) as ticket_count
    from active_holders group by contact_id, event_id having count(*) > 1
  )
  select
    'DUPLICATE_ACTIVE_HOLDER'::text, 'critical'::text, 'titularidade'::text,
    'Titular duplicado no mesmo evento'::text,
    'Esta pessoa aparece como titular de mais de um ingresso ativo no mesmo evento.'::text,
    ah.event_id, 'ticket'::text, ah.ticket_id,
    'Abrir ingresso'::text, '/ingressos/' || ah.ticket_id,
    jsonb_build_object('registration_contact_id', ah.contact_id, 'ticket_count', c.ticket_count)
  from active_holders ah
  join conflicts c on c.contact_id = ah.contact_id and c.event_id = ah.event_id;
$$;
revoke all on function public.detect_integrity_duplicate_active_holder(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_duplicate_active_holder(uuid, uuid) to service_role;

-- A3. participants e mantida como projecao legada event-scoped e so e
-- resolvida/criada automaticamente NO INSERT (trigger
-- sync_participant_registration_contact) -- nunca re-sincronizada depois.
-- Uma transferencia de titular (que atualiza order_items.registration_contact_id
-- e tickets.participant_id em conjunto) pode deixar a projecao legada do
-- participante antigo divergente do vinculo comercial atual do ingresso.
create or replace function public.detect_integrity_legacy_holder_mismatch(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'LEGACY_HOLDER_REFERENCE_MISMATCH'::text, 'attention'::text, 'titularidade'::text,
    'Referência de titularidade desatualizada'::text,
    'O cadastro vinculado a este ingresso não corresponde mais ao titular atual — provavelmente após uma transferência.'::text,
    oi.event_id, 'order_item'::text, oi.id,
    'Abrir ingresso'::text, case when t.id is not null then '/ingressos/' || t.id else '/ingressos' end,
    jsonb_build_object('order_item_registration_contact_id', oi.registration_contact_id, 'participant_registration_contact_id', p.registration_contact_id)
  from public.order_items oi
  join public.events e on e.id = oi.event_id
  join public.participants p on p.id = oi.participant_id
  left join public.tickets t on t.order_item_id = oi.id and t.status <> 'cancelled'
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and oi.registration_contact_id is not null
    and p.registration_contact_id is not null
    and oi.registration_contact_id is distinct from p.registration_contact_id
    and oi.status not in ('cancelled', 'expired', 'refunded');
$$;
revoke all on function public.detect_integrity_legacy_holder_mismatch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_legacy_holder_mismatch(uuid, uuid) to service_role;

-- ============================================================
-- 4. Detectores -- Ingressos / Pedidos
-- ============================================================

-- B1. Testa exatamente o invariante que hoje so e garantido "por convencao"
-- (todo escritor que confirma um order_item chama confirm_order_item_and_issue_ticket
-- na mesma transacao) -- nao ha trigger de banco garantindo isso. Store/loja
-- nunca gera order_items (e um modelo comercial totalmente separado:
-- store_orders/store_order_items), entao nao ha risco de falso positivo ali.
create or replace function public.detect_integrity_paid_order_without_ticket(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'PAID_ORDER_WITHOUT_TICKET'::text, 'critical'::text, 'ingressos_pedidos'::text,
    'Pedido pago sem ingresso emitido'::text,
    'O pagamento deste pedido foi confirmado, mas o ingresso correspondente não foi emitido.'::text,
    oi.event_id, 'order_item'::text, oi.id,
    'Abrir pedido'::text, '/pedidos?eventId=' || oi.event_id || '&q=' || o.order_number,
    jsonb_build_object('order_id', o.id, 'order_number', o.order_number, 'order_item_status', oi.status)
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.events e on e.id = oi.event_id
  left join public.tickets t on t.order_item_id = oi.id and t.status <> 'cancelled'
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and oi.status in ('confirmed', 'transferred')
    and exists (select 1 from public.payments pay where (pay.order_id = o.id or pay.id = o.payment_id) and pay.payment_status = 'paid')
    and t.id is null;
$$;
revoke all on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) to service_role;

-- B2. tickets.order_item_id e nullable com FK ON DELETE SET NULL -- o schema
-- PERMITE um ticket orfao, mas nenhuma RPC ativa hoje cria ou deixaria esse
-- estado (nenhum "delete from order_items" existe no codigo). Emissao manual
-- sempre cria order_items antes de emitir o ticket -- nao ha excecao
-- legitima para ingressos administrativos. Detector de regressao/seguranca.
create or replace function public.detect_integrity_ticket_without_order_item(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_WITHOUT_ORDER_ITEM'::text, 'critical'::text, 'ingressos_pedidos'::text,
    'Ingresso sem vínculo comercial'::text,
    'Este ingresso perdeu a referência ao item de pedido que o originou — a relação comercial está quebrada.'::text,
    t.event_id, 'ticket'::text, t.id,
    'Abrir ingresso'::text, '/ingressos/' || t.id,
    jsonb_build_object('ticket_status', t.status, 'order_id', t.order_id)
  from public.tickets t
  where t.organization_id = p_organization_id
    and (p_event_id is null or t.event_id = p_event_id)
    and t.order_item_id is null
    and t.status <> 'cancelled';
$$;
revoke all on function public.detect_integrity_ticket_without_order_item(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_ticket_without_order_item(uuid, uuid) to service_role;

-- B3 (evento inexistente/inativo) foi descartado: event_id em tickets e NOT
-- NULL com FK real (evento inexistente e impossivel), e ingresso ativo em
-- evento arquivado (is_active=false) e ciclo de vida normal, nao erro.

-- ============================================================
-- 5. Detectores -- Categoria / Lote / Preco (reusam as MESMAS funcoes do
--    pricing RPC, nunca uma segunda implementacao que possa divergir)
-- ============================================================

-- C1. get_event_single_ticket_price_status ja e exatamente essa checagem
-- (active_category_count=0 + registration_enabled + not price_confirmed) --
-- so chamamos a funcao existente por evento, sem reimplementar a regra.
create or replace function public.detect_integrity_single_ticket_price_unconfirmed(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language plpgsql security definer set search_path = public, pg_temp as $$
declare v_event record;
begin
  for v_event in
    select e.id, e.name from public.events e
    where e.organization_id = p_organization_id and (p_event_id is null or e.id = p_event_id) and e.registration_enabled
  loop
    return query
    select
      'SINGLE_TICKET_PRICE_NOT_CONFIRMED'::text, 'critical'::text, 'categoria_preco'::text,
      'Preço do ingresso único não configurado'::text,
      'As vendas estão abertas, mas o preço do ingresso único ainda não foi confirmado.'::text,
      v_event.id, 'event'::text, v_event.id,
      'Configurar preço'::text, '/painel/eventos/' || v_event.id,
      jsonb_build_object('event_name', v_event.name)
    from public.get_event_single_ticket_price_status(v_event.id) s
    where s.active_category_count = 0 and s.registration_enabled and not s.price_confirmed;
  end loop;
end; $$;
revoke all on function public.detect_integrity_single_ticket_price_unconfirmed(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_single_ticket_price_unconfirmed(uuid, uuid) to service_role;

-- C2. Reusa get_event_ticket_categories (a mesma funcao que
-- get_registration_pricing_preview usa) para achar categorias
-- ativas+elegiveis (slot livre + lote corrente valido). So sinaliza quando
-- ha categorias ativas configuradas mas NENHUMA e elegivel agora, com
-- vendas abertas -- evento de ingresso unico (0 categorias) nunca cai aqui.
create or replace function public.detect_integrity_no_purchasable_category(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language plpgsql security definer set search_path = public, pg_temp as $$
declare v_event record; v_active_categories integer; v_eligible_categories integer;
begin
  for v_event in
    select e.id, e.name from public.events e
    where e.organization_id = p_organization_id and (p_event_id is null or e.id = p_event_id) and e.registration_enabled
  loop
    select count(*) into v_active_categories from public.ticket_categories tc where tc.event_id = v_event.id and tc.is_active = true;
    if v_active_categories = 0 then continue; end if;

    select count(*) into v_eligible_categories from public.get_event_ticket_categories(v_event.id) tc
    where tc.is_active and (tc.available_slots is null or tc.available_slots > 0) and tc.current_batch_id is not null;

    if v_eligible_categories = 0 then
      return query select
        'NO_PURCHASABLE_CATEGORY_OPTION'::text, 'critical'::text, 'categoria_preco'::text,
        'Nenhuma opção de compra disponível'::text,
        'As vendas estão abertas e o evento tem categorias configuradas, mas nenhuma delas está disponível para compra no momento.'::text,
        v_event.id, 'event'::text, v_event.id,
        'Configurar preço'::text, '/painel/eventos/' || v_event.id,
        jsonb_build_object('event_name', v_event.name, 'active_categories', v_active_categories);
    end if;
  end loop;
end; $$;
revoke all on function public.detect_integrity_no_purchasable_category(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_no_purchasable_category(uuid, uuid) to service_role;

-- C3. ticket_category_id/batch_id em order_items sao validos por FK quando
-- preenchidos (nunca apontam para linha inexistente), mas nada impede que
-- apontem para uma categoria/lote de OUTRO evento -- nenhuma FK garante
-- coerencia cruzada entre order_items.event_id e ticket_categories.event_id/
-- registration_batches.event_id.
create or replace function public.detect_integrity_category_event_mismatch(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'ORDER_ITEM_CATEGORY_EVENT_MISMATCH'::text, 'critical'::text, 'categoria_preco'::text,
    'Categoria ou lote de outro evento'::text,
    'Este ingresso referencia uma categoria ou lote que pertence a um evento diferente do evento do ingresso.'::text,
    oi.event_id, 'order_item'::text, oi.id,
    'Abrir pedido'::text, '/pedidos?eventId=' || oi.event_id || '&q=' || o.order_number,
    jsonb_build_object('order_id', o.id, 'order_number', o.order_number, 'category_event_id', tc.event_id, 'batch_event_id', rb.event_id)
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.events e on e.id = oi.event_id
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.registration_batches rb on rb.id = oi.batch_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and (
      (tc.id is not null and tc.event_id <> oi.event_id)
      or (rb.id is not null and rb.event_id <> oi.event_id)
    );
$$;
revoke all on function public.detect_integrity_category_event_mismatch(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_category_event_mismatch(uuid, uuid) to service_role;

-- ============================================================
-- 6. Detectores -- Camisetas e Kits
-- ============================================================

-- D1. "Deveria ter camiseta" = existe event_kit_items ativo, item_type='shirt',
-- requires_variant=true para o evento (mesma condicao usada por
-- create_manual_registration_order para exigir camiseta no checkout).
-- "Sem variante valida" = nao ha participant_kit_items nao-cancelado com
-- variant_data preenchido para aquele ingresso+kit_item. Evento sem kit de
-- camiseta nunca aparece aqui.
create or replace function public.detect_integrity_missing_shirt_variant(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_MISSING_REQUIRED_SHIRT_VARIANT'::text, 'attention'::text, 'camisetas_kits'::text,
    'Camiseta não definida'::text,
    'Este ingresso tem direito a camiseta, mas ainda não possui tamanho/variante definido.'::text,
    t.event_id, 'ticket'::text, t.id,
    'Abrir ingresso'::text, '/ingressos/' || t.id || '/editar',
    jsonb_build_object('kit_item_id', eki.id, 'kit_item_name', eki.name)
  from public.tickets t
  join public.event_kit_items eki on eki.event_id = t.event_id and eki.item_type = 'shirt' and eki.is_active = true and eki.requires_variant = true
  left join public.participant_kit_items pki on pki.kit_item_id = eki.id
    and pki.status <> 'cancelled'
    and (pki.ticket_id = t.id or (pki.ticket_id is null and pki.order_item_id = t.order_item_id))
  where t.organization_id = p_organization_id
    and (p_event_id is null or t.event_id = p_event_id)
    and t.status <> 'cancelled'
    and (
      pki.id is null
      or pki.variant_data is null
      or coalesce(pki.variant_data->>'variant_id', '') = ''
    );
$$;
revoke all on function public.detect_integrity_missing_shirt_variant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_missing_shirt_variant(uuid, uuid) to service_role;

-- D2 (variante removida/invalida) foi descartado: participant_kit_items.variant_data
-- e um snapshot jsonb (shirt_type/shirt_size), nao uma referencia (FK) viva a
-- event_kit_item_variants -- nao ha "referencia quebrada" possivel de checar.

-- D3. admin_cancel_ticket E admin_update_payment_status bloqueiam cancelar
-- um ingresso com kit ja ENTREGUE -- mas admin_update_payment_status (fluxo
-- de regressao de pagamento) cancela o ticket sem liberar os itens de kit
-- ainda 'reserved'/'confirmed' (nao entregues) nem o estoque reservado --
-- gap real confirmado lendo o codigo, nao suposicao.
create or replace function public.detect_integrity_cancelled_ticket_pending_kit(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_CANCELLED_WITH_PENDING_KIT_ITEM'::text, 'critical'::text, 'camisetas_kits'::text,
    'Item de kit preso a ingresso cancelado'::text,
    'Este ingresso foi cancelado, mas ainda existe um item de kit reservado/confirmado vinculado a ele.'::text,
    t.event_id, 'ticket'::text, t.id,
    'Abrir ingresso'::text, '/ingressos/' || t.id,
    jsonb_build_object('kit_item_status', pki.status, 'kit_item_id', pki.kit_item_id)
  from public.participant_kit_items pki
  join public.tickets t on t.id = pki.ticket_id or (pki.ticket_id is null and t.order_item_id = pki.order_item_id)
  where t.organization_id = p_organization_id
    and (p_event_id is null or t.event_id = p_event_id)
    and pki.status in ('reserved', 'confirmed')
    and t.status = 'cancelled';
$$;
revoke all on function public.detect_integrity_cancelled_ticket_pending_kit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_cancelled_ticket_pending_kit(uuid, uuid) to service_role;

-- ============================================================
-- 7. Detectores -- Estoque
-- ============================================================

-- E1. reserved_quantity > estoque fisico e demanda agregada esperada --
-- NUNCA um problema (decisao arquitetural preservada, nao viramos alerta
-- por isso). O que e realmente impossivel: delivered_quantity > total_quantity
-- (entregou mais do que jamais entrou). shirt_inventory NAO tem CHECK
-- reserved+delivered<=total (diferente da tabela de variantes, que tem) --
-- gap real confirmado no schema, nao coberto por nenhuma constraint.
create or replace function public.detect_integrity_shirt_inventory_overdelivered(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'SHIRT_INVENTORY_DELIVERED_EXCEEDS_TOTAL'::text, 'critical'::text, 'estoque'::text,
    'Estoque de camiseta inconsistente'::text,
    'A quantidade entregue deste item é maior do que a quantidade total registrada em estoque.'::text,
    si.event_id, 'shirt_inventory'::text, si.id,
    'Ver estoque'::text, '/camisetas',
    jsonb_build_object('shirt_type', si.shirt_type, 'shirt_size', si.shirt_size, 'total_quantity', si.total_quantity, 'delivered_quantity', si.delivered_quantity)
  from public.shirt_inventory si
  where si.organization_id = p_organization_id
    and (p_event_id is null or si.event_id = p_event_id)
    and si.delivered_quantity > si.total_quantity;
$$;
revoke all on function public.detect_integrity_shirt_inventory_overdelivered(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_shirt_inventory_overdelivered(uuid, uuid) to service_role;

-- ============================================================
-- 8. Detectores -- Check-in / Retirada
-- ============================================================

-- F1. Nenhum caminho de escrita ativo permite check-in em ingresso cancelado
-- (checkin_ticket_entry bloqueia) nem cancelamento de ingresso ja com
-- used_at preenchido (admin_cancel_ticket e admin_update_payment_status
-- bloqueiam ambos). Estado hoje inalcancavel pelas RPCs -- detector de
-- regressao/seguranca, mesma categoria de B2.
create or replace function public.detect_integrity_cancelled_ticket_checkin(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'TICKET_CANCELLED_WITH_CHECKIN'::text, 'critical'::text, 'checkin_retirada'::text,
    'Check-in registrado em ingresso cancelado'::text,
    'Este ingresso está cancelado, mas possui um registro de check-in — os dois estados não podem coexistir.'::text,
    t.event_id, 'ticket'::text, t.id,
    'Abrir ingresso'::text, '/ingressos/' || t.id,
    jsonb_build_object('used_at', t.used_at, 'cancelled_at', t.cancelled_at)
  from public.tickets t
  where t.organization_id = p_organization_id
    and (p_event_id is null or t.event_id = p_event_id)
    and t.status = 'cancelled'
    and t.used_at is not null;
$$;
revoke all on function public.detect_integrity_cancelled_ticket_checkin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_cancelled_ticket_checkin(uuid, uuid) to service_role;

-- ============================================================
-- 9. Detectores -- Cadastros (reusa participant_data_issues, nunca uma
--    segunda definicao de "dado obrigatorio ausente")
-- ============================================================

-- G1. Qualquer pendencia aberta que bloqueia pagamento/emissao/checkin/kit,
-- exceto insufficient_named_holder_identity (que ja tem detector proprio em
-- Titularidade, com blocks_*=false -- nao se sobrepoe aqui). Severidade
-- dinamica: bloquear pagamento/emissao e critico; bloquear so
-- checkin/kit (que so importa mais perto do evento) e atencao.
create or replace function public.detect_integrity_open_blocking_data_issue(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'OPEN_BLOCKING_DATA_ISSUE'::text,
    case when pdi.blocks_payment or pdi.blocks_ticket_issuance then 'critical' else 'attention' end,
    'cadastros'::text,
    'Pendência de cadastro'::text,
    coalesce(nullif(trim(pdi.message), ''), 'Existe uma pendência de dados que pode afetar a operação deste cadastro.'),
    pdi.event_id,
    case when pdi.ticket_id is not null then 'ticket' when pdi.order_item_id is not null then 'order_item' else 'registration_contact' end,
    coalesce(pdi.ticket_id, pdi.order_item_id, pdi.registration_contact_id),
    'Abrir cadastro'::text,
    case when pdi.ticket_id is not null then '/ingressos/' || pdi.ticket_id
         when pdi.registration_contact_id is not null then '/cadastros/' || pdi.registration_contact_id
         else '/cadastros' end,
    jsonb_build_object('issue_id', pdi.id, 'issue_type', pdi.issue_type, 'field_code', pdi.field_code,
      'blocks_payment', pdi.blocks_payment, 'blocks_ticket_issuance', pdi.blocks_ticket_issuance,
      'blocks_checkin', pdi.blocks_checkin, 'blocks_kit_delivery', pdi.blocks_kit_delivery)
  from public.participant_data_issues pdi
  join public.events e on e.id = pdi.event_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or pdi.event_id = p_event_id)
    and pdi.status = 'open'
    and pdi.issue_type <> 'insufficient_named_holder_identity'
    and (pdi.blocks_payment or pdi.blocks_ticket_issuance or pdi.blocks_checkin or pdi.blocks_kit_delivery);
$$;
revoke all on function public.detect_integrity_open_blocking_data_issue(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_open_blocking_data_issue(uuid, uuid) to service_role;

-- ============================================================
-- 10. Detectores -- Configuracao do evento
-- ============================================================

-- H1. Evento exige camiseta (mesma condicao de D1/checkout) mas nao tem
-- NENHUM tamanho/variante ativo cadastrado -- ninguem conseguiria escolher
-- um tamanho no checkout. Critico se vendas ja abertas; aviso se ainda nao.
create or replace function public.detect_integrity_shirt_kit_without_variants(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'EVENT_SHIRT_KIT_WITHOUT_VARIANTS'::text,
    case when e.registration_enabled then 'critical' else 'warning' end,
    'configuracao_evento'::text,
    'Camiseta obrigatória sem tamanhos configurados'::text,
    'Este evento exige camiseta, mas nenhum tamanho/variante foi cadastrado.'::text,
    e.id, 'event'::text, e.id,
    'Configurar camiseta'::text, '/painel/eventos/' || e.id,
    jsonb_build_object('event_name', e.name, 'kit_item_id', eki.id)
  from public.event_kit_items eki
  join public.events e on e.id = eki.event_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or e.id = p_event_id)
    and eki.item_type = 'shirt' and eki.is_active = true and eki.requires_variant = true
    and not exists (select 1 from public.event_kit_item_variants v where v.kit_item_id = eki.id and v.is_active = true);
$$;
revoke all on function public.detect_integrity_shirt_kit_without_variants(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_shirt_kit_without_variants(uuid, uuid) to service_role;

-- ============================================================
-- 11. RPC agregadora -- unica porta de entrada do browser. Resolve
--     organizacao sempre no servidor (nunca do client), valida event_id
--     contra essa organizacao, faz UNION ALL de todos os detectores e
--     agrupa por (code,event_id) para o resumo -- 1 round-trip.
-- ============================================================

create or replace function public.get_operational_integrity_report(p_event_id uuid default null)
returns table(
  code text, severity text, domain text, title text, description text, event_id uuid,
  affected_count integer, action_label text, action_href text, sample_entity_type text, sample_entity_id uuid
) language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_org uuid;
begin
  if v_actor is null or not public.current_user_has_permission('integrity.view') then
    raise exception 'Sem permissao para ver integridade operacional.';
  end if;
  v_org := public.current_organization_id();
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;
  if p_event_id is not null and not exists (select 1 from public.events e where e.id = p_event_id and e.organization_id = v_org) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;

  return query
  with raw as (
    select * from public.detect_integrity_named_without_holder(v_org, p_event_id)
    union all select * from public.detect_integrity_duplicate_active_holder(v_org, p_event_id)
    union all select * from public.detect_integrity_legacy_holder_mismatch(v_org, p_event_id)
    union all select * from public.detect_integrity_paid_order_without_ticket(v_org, p_event_id)
    union all select * from public.detect_integrity_ticket_without_order_item(v_org, p_event_id)
    union all select * from public.detect_integrity_single_ticket_price_unconfirmed(v_org, p_event_id)
    union all select * from public.detect_integrity_no_purchasable_category(v_org, p_event_id)
    union all select * from public.detect_integrity_category_event_mismatch(v_org, p_event_id)
    union all select * from public.detect_integrity_missing_shirt_variant(v_org, p_event_id)
    union all select * from public.detect_integrity_cancelled_ticket_pending_kit(v_org, p_event_id)
    union all select * from public.detect_integrity_shirt_inventory_overdelivered(v_org, p_event_id)
    union all select * from public.detect_integrity_cancelled_ticket_checkin(v_org, p_event_id)
    union all select * from public.detect_integrity_open_blocking_data_issue(v_org, p_event_id)
    union all select * from public.detect_integrity_shirt_kit_without_variants(v_org, p_event_id)
  ),
  grouped as (
    select
      r.code, r.severity, r.domain, (array_agg(r.title))[1] as title, (array_agg(r.description))[1] as description,
      r.event_id, count(*)::integer as affected_count,
      (array_agg(r.action_label))[1] as action_label, (array_agg(r.action_href))[1] as action_href,
      (array_agg(r.entity_type))[1] as sample_entity_type, (array_agg(r.entity_id))[1] as sample_entity_id
    from raw r
    group by r.code, r.severity, r.domain, r.event_id
  )
  select g.code, g.severity, g.domain, g.title, g.description, g.event_id, g.affected_count,
    g.action_label, g.action_href, g.sample_entity_type, g.sample_entity_id
  from grouped g
  order by (case g.severity when 'critical' then 0 when 'attention' then 1 when 'warning' then 2 else 3 end), g.domain, g.code;
end; $$;

revoke all on function public.get_operational_integrity_report(uuid) from public, anon;
grant execute on function public.get_operational_integrity_report(uuid) to authenticated;

-- ============================================================
-- 12. RPC de detalhe -- reusa os MESMOS detectores (nao agrupados),
--     filtrados por code, para o drawer "Ver N registros".
-- ============================================================

create or replace function public.get_operational_integrity_issue_entities(p_code text, p_event_id uuid default null)
returns table(
  entity_type text, entity_id uuid, event_id uuid, title text, description text,
  action_label text, action_href text, metadata jsonb
) language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := auth.uid(); v_org uuid;
begin
  if v_actor is null or not public.current_user_has_permission('integrity.view') then
    raise exception 'Sem permissao para ver integridade operacional.';
  end if;
  v_org := public.current_organization_id();
  if v_org is null or not public.user_can_access_organization(v_actor, v_org) then
    raise exception 'Acesso negado a organizacao.';
  end if;
  if p_event_id is not null and not exists (select 1 from public.events e where e.id = p_event_id and e.organization_id = v_org) then
    raise exception 'Evento invalido ou sem acesso a organizacao.';
  end if;
  if nullif(trim(coalesce(p_code, '')), '') is null then
    raise exception 'Codigo de verificacao obrigatorio.';
  end if;

  return query
  select r.entity_type, r.entity_id, r.event_id, r.title, r.description, r.action_label, r.action_href, r.metadata
  from (
    select * from public.detect_integrity_named_without_holder(v_org, p_event_id)
    union all select * from public.detect_integrity_duplicate_active_holder(v_org, p_event_id)
    union all select * from public.detect_integrity_legacy_holder_mismatch(v_org, p_event_id)
    union all select * from public.detect_integrity_paid_order_without_ticket(v_org, p_event_id)
    union all select * from public.detect_integrity_ticket_without_order_item(v_org, p_event_id)
    union all select * from public.detect_integrity_single_ticket_price_unconfirmed(v_org, p_event_id)
    union all select * from public.detect_integrity_no_purchasable_category(v_org, p_event_id)
    union all select * from public.detect_integrity_category_event_mismatch(v_org, p_event_id)
    union all select * from public.detect_integrity_missing_shirt_variant(v_org, p_event_id)
    union all select * from public.detect_integrity_cancelled_ticket_pending_kit(v_org, p_event_id)
    union all select * from public.detect_integrity_shirt_inventory_overdelivered(v_org, p_event_id)
    union all select * from public.detect_integrity_cancelled_ticket_checkin(v_org, p_event_id)
    union all select * from public.detect_integrity_open_blocking_data_issue(v_org, p_event_id)
    union all select * from public.detect_integrity_shirt_kit_without_variants(v_org, p_event_id)
  ) r
  where r.code = p_code;
end; $$;

revoke all on function public.get_operational_integrity_issue_entities(text, uuid) from public, anon;
grant execute on function public.get_operational_integrity_issue_entities(text, uuid) to authenticated;

-- ============================================================
-- 13. RPC utilitaria -- total de verificacoes disponiveis (para o card
--     "X verificacoes aprovadas" = total - codigos distintos com problema).
--     Lista fixa em codigo (nao consulta nada) -- unica fonte de verdade do
--     "quantos detectores existem" para o resumo, sem duplicar a contagem
--     manualmente no frontend.
-- ============================================================

create or replace function public.get_operational_integrity_detector_codes()
returns text[] language sql immutable as $$
  select array[
    'TICKET_NAMED_WITHOUT_CANONICAL_HOLDER','DUPLICATE_ACTIVE_HOLDER','LEGACY_HOLDER_REFERENCE_MISMATCH',
    'PAID_ORDER_WITHOUT_TICKET','TICKET_WITHOUT_ORDER_ITEM',
    'SINGLE_TICKET_PRICE_NOT_CONFIRMED','NO_PURCHASABLE_CATEGORY_OPTION','ORDER_ITEM_CATEGORY_EVENT_MISMATCH',
    'TICKET_MISSING_REQUIRED_SHIRT_VARIANT','TICKET_CANCELLED_WITH_PENDING_KIT_ITEM',
    'SHIRT_INVENTORY_DELIVERED_EXCEEDS_TOTAL',
    'TICKET_CANCELLED_WITH_CHECKIN',
    'OPEN_BLOCKING_DATA_ISSUE',
    'EVENT_SHIRT_KIT_WITHOUT_VARIANTS'
  ]::text[];
$$;
revoke all on function public.get_operational_integrity_detector_codes() from public, anon;
grant execute on function public.get_operational_integrity_detector_codes() to authenticated;

commit;
