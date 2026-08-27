begin;

-- P0 -- reauditoria do caso real de producao #001078 (Central de Integridade
-- Operacional, detector PAID_ORDER_WITHOUT_TICKET). A 20260908000000 ja
-- corrigiu o action_href (link direto pro pedido); esta migration fecha o
-- restante do achado da auditoria, que ficou de fora daquela por engano:
--
-- 1) FALSO POSITIVO em item de produto/add-on: a WHERE clause nao filtrava
--    oi.item_kind, entao qualquer order_item pago sem ticket (inclusive
--    produtos avulsos, que nunca emitem ticket) contava como bloqueio.
--    Corrigido restringindo o detector a oi.item_kind = 'ticket'.
-- 2) UX do card resumido: titulo generico ("Pedido pago sem ingresso
--    emitido") e action_label generico ("Abrir pedido") nao comunicavam
--    nem a causa nem a acao esperada. Atualizados pra "Ingresso não
--    emitido" / "Resolver agora", com a descricao explicando causa (nunca
--    emitido OU cancelado sem substituto) + acao recomendada.
-- 3) category_name ausente no metadata: o card resumido (entity-card.tsx,
--    buildCard) ja usa metadata.category_name pro contexto "quem/qual",
--    mas o detector nunca populava esse campo -- adicionado via join em
--    ticket_categories (nullable, categoria pode nao estar definida).
--
-- Deteccao por order_items.id -> tickets.order_item_id e o tratamento de
-- ticket cancelado como ausencia de ticket valido (left join filtrando
-- t.status <> 'cancelled') ja estavam corretos na 908 e permanecem
-- inalterados aqui. action_href continua '/inscricoes/pedido/' || o.id.
create or replace function public.detect_integrity_paid_order_without_ticket(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'PAID_ORDER_WITHOUT_TICKET'::text, 'critical'::text, 'ingressos_pedidos'::text,
    'Ingresso não emitido'::text,
    'O pagamento deste pedido foi confirmado, mas o item não tem nenhum ticket ativo vinculado (nunca emitido ou cancelado sem substituto) — abra o pedido e emita o ingresso para resolver.'::text,
    oi.event_id, 'order_item'::text, oi.id,
    'Resolver agora'::text, '/inscricoes/pedido/' || o.id,
    jsonb_build_object(
      'order_id', o.id, 'order_number', o.order_number, 'order_item_status', oi.status,
      'event_name', e.name, 'holder_name', coalesce(rc.full_name, oi.holder_full_name),
      'category_name', tc.name, 'final_amount', oi.final_amount
    )
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.events e on e.id = oi.event_id
  left join public.tickets t on t.order_item_id = oi.id and t.status <> 'cancelled'
  left join public.registration_contacts rc on rc.id = oi.registration_contact_id
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and oi.item_kind = 'ticket'
    and oi.status in ('confirmed', 'transferred')
    and exists (select 1 from public.payments pay where (pay.order_id = o.id or pay.id = o.payment_id) and pay.payment_status = 'paid')
    and t.id is null;
$$;
revoke all on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) to service_role;

commit;
