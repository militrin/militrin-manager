-- Falso positivo na Central de Integridade: PAID_ORDER_WITHOUT_TICKET
-- (detect_integrity_paid_order_without_ticket) nunca filtrava por
-- order_items.item_kind -- desde 20260825000000_order_items_product_lines.sql
-- order_items TAMBEM guarda linhas de PRODUTO "compre junto"
-- (item_kind='product', aponta pra store_items, nunca gera ticket por
-- design -- ver 20260916000000/20260917000000, que deram a esse dominio seu
-- proprio QR/entrega via order_items.qr_token e deliver_order_item_product).
-- O detector, porem, continuava testando QUALQUER order_item confirmado e
-- pago contra "existe ticket ativo?", sem nunca excluir linhas que o proprio
-- schema ja marca como nao-ingresso.
--
-- Caso real confirmado em producao (auditoria desta migration, consulta
-- read-only via service_role): dos 4 registros hoje apontados pelo
-- detector, 3 sao order_items com item_kind='product' (pedidos
-- MIL-2026-00001086 x2 e MIL-2026-00001089 x1, todos "Copo Termico" --
-- nunca deveriam ter ticket) e 1 e um item_kind='ticket' legitimamente
-- bloqueante (pedido MIL-2026-00001078, ticket cancelado em 2026-08-25,
-- ANTES da coluna cancellation_replacement_required existir -- portanto
-- NULL, que a regra de 20260924000000 trata corretamente como "aguardando
-- classificacao do Owner", nao como falso positivo).
--
-- Fonte canonica ja existente para "este item deveria gerar ticket?":
-- order_items.item_kind ('ticket'|'product', CHECK constraint desde
-- 20260825000000). Nenhuma evolucao de schema necessaria -- o discriminador
-- estrutural ja existe, so nao era usado aqui. Unica mudanca: acrescentar
-- `oi.item_kind = 'ticket'` ao WHERE, preservando integralmente a regra de
-- cancelamento/substituicao de 20260924000000 (ticket cancelado com
-- cancellation_replacement_required=false nao bloqueia; NULL ou true
-- continuam bloqueando).
begin;

create or replace function public.detect_integrity_paid_order_without_ticket(p_organization_id uuid, p_event_id uuid)
returns setof public.integrity_issue_row language sql stable security definer set search_path = public, pg_temp as $$
  select
    'PAID_ORDER_WITHOUT_TICKET'::text, 'critical'::text, 'ingressos_pedidos'::text,
    'Pedido pago sem ingresso emitido'::text,
    'O pagamento deste pedido foi confirmado, mas o ingresso correspondente não foi emitido.'::text,
    oi.event_id, 'order_item'::text, oi.id,
    'Abrir pedido'::text, '/inscricoes/pedido/' || o.id,
    jsonb_build_object(
      'order_id', o.id, 'order_number', o.order_number, 'order_item_status', oi.status,
      'event_name', e.name, 'holder_name', coalesce(rc.full_name, oi.holder_full_name),
      'final_amount', oi.final_amount
    )
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.events e on e.id = oi.event_id
  left join public.tickets t on t.order_item_id = oi.id and t.status <> 'cancelled'
  left join public.registration_contacts rc on rc.id = oi.registration_contact_id
  where e.organization_id = p_organization_id
    and (p_event_id is null or oi.event_id = p_event_id)
    and oi.item_kind = 'ticket'
    and oi.status in ('confirmed', 'transferred')
    and exists (select 1 from public.payments pay where (pay.order_id = o.id or pay.id = o.payment_id) and pay.payment_status = 'paid')
    and t.id is null
    and not exists (
      select 1 from public.tickets ct
      where ct.order_item_id = oi.id and ct.status = 'cancelled' and ct.cancellation_replacement_required = false
    );
$$;
revoke all on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) to service_role;

commit;
