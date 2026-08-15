-- 141_manual_ticket_issue_organization_preflight.sql
-- SELECT-only. Confirma a cadeia evento -> pedido -> item -> ticket antes/depois da 141.

select t.id ticket_id,t.status,t.participant_id,t.event_id ticket_event_id,
  t.organization_id ticket_organization_id,o.id order_id,o.event_id order_event_id,
  o.organization_id order_organization_id,oi.id order_item_id,oi.event_id order_item_event_id,
  e.organization_id event_organization_id,
  case when t.event_id=e.id and o.event_id=e.id and oi.event_id=e.id
    and t.organization_id=e.organization_id and o.organization_id=e.organization_id
    then 'CONSISTENTE' else 'DIVERGENTE' end classification
from public.tickets t
join public.orders o on o.id=t.order_id
join public.order_items oi on oi.id=t.order_item_id
join public.events e on e.id=t.event_id
order by classification,t.issued_at desc;

-- Resultado esperado: zero linhas.
select t.id ticket_id,t.organization_id ticket_organization_id,
  o.organization_id order_organization_id,e.organization_id event_organization_id
from public.tickets t join public.orders o on o.id=t.order_id join public.events e on e.id=t.event_id
where t.organization_id is distinct from e.organization_id
   or o.organization_id is distinct from e.organization_id;
