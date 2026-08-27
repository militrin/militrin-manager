begin;

-- Bug real na Central de Integridade Operacional: o CTA "Abrir pedido" do
-- detector PAID_ORDER_WITHOUT_TICKET apontava pra
-- '/pedidos?eventId=' || event_id || '&q=' || order_number -- uma LISTAGEM
-- filtrada por texto, nao um link direto pro pedido. Dois problemas reais:
--
-- 1) /pedidos so lista pedidos quando ha um evento valido selecionado E o
--    filtro `q` bate com `orderDisplayReference(display_number, order_number)`
--    (string formatada, ex. "MIL-2026-00001068") via `.includes()` no client
--    -- mas o href usava o `order_number` CRU (coluna orders.order_number),
--    que pode nao ser essa mesma string formatada. Quando os dois valores
--    divergem, a busca nao encontra nada e a tela some sem erro visivel --
--    e exatamente o "clico e nao acontece nada" relatado.
-- 2) Mesmo quando o filtro bate, o resultado e uma LISTA (o admin ainda
--    precisa expandir a linha certa e clicar em "Abrir ficha" de novo) --
--    nao "abre o pedido", que era o pedido explicito da tarefa.
--
-- Correcao: usar a mesma rota canonica de detalhe de pedido por UUID que o
-- Dashboard ja usa pra este EXATO cenario (pedido sem ingresso emitido --
-- ver comentario em src/app/inscricoes/pedido/[orderId]/page.tsx e o uso em
-- src/lib/dashboard/admin-dashboard-data.ts:160): '/inscricoes/pedido/' ||
-- o.id (order_id, chave interna estavel -- nunca order_number/display_number
-- como identificador de rota). Nao criei nenhuma pagina nova; a rota ja
-- existe, ja mostra "Ingresso nao emitido" pra item sem ticket, e ja e
-- protegida por requirePermission('participants.view') no proprio layout
-- (src/app/inscricoes/layout.tsx) -- autorizacao no destino inalterada.
--
-- Isso tambem resolve automaticamente o caso de multiplos pedidos afetados:
-- get_operational_integrity_issue_entities reusa esta MESMA funcao detector
-- (sem agrupar) pro drawer "Ver N registros" -- cada linha ja tem seu
-- proprio action_href individual (um por order_item/pedido realmente
-- afetado), entao a correcao aqui cobre tanto o CTA de "1 afetado" quanto
-- cada entrada da lista quando ha varios.
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
    and oi.status in ('confirmed', 'transferred')
    and exists (select 1 from public.payments pay where (pay.order_id = o.id or pay.id = o.payment_id) and pay.payment_status = 'paid')
    and t.id is null;
$$;
revoke all on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) from public, anon, authenticated;
grant execute on function public.detect_integrity_paid_order_without_ticket(uuid, uuid) to service_role;

commit;
