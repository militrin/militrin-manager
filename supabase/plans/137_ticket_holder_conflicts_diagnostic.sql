-- Somente leitura. Localiza cadastros titulares de mais de um ingresso ativo no mesmo evento.
with active_holders as (
  select coalesce(oi.registration_contact_id,p.registration_contact_id) registration_contact_id,
    t.event_id,t.id ticket_id,t.order_item_id,t.order_id,t.issued_at,
    o.user_id buyer_user_id,o.buyer_type,oi.participant_id,oi.holder_full_name,
    ph.source,ph.import_batch_id
  from public.tickets t
  join public.order_items oi on oi.id=t.order_item_id
  left join public.participants p on p.id=coalesce(oi.participant_id,t.participant_id)
  left join public.orders o on o.id=t.order_id
  left join lateral (
    select h.source,h.import_batch_id from public.participation_history h
    where h.participant_id=coalesce(oi.participant_id,t.participant_id) and h.event_id=t.event_id
    order by h.created_at limit 1
  ) ph on true
  where t.status not in ('cancelled','canceled','void','voided')
    and coalesce(oi.registration_contact_id,p.registration_contact_id) is not null
), conflicts as (
  select registration_contact_id,event_id,count(*) ticket_count
  from active_holders group by registration_contact_id,event_id having count(*)>1
)
select c.registration_contact_id,rc.full_name,e.id event_id,e.name event_name,c.ticket_count,
  a.ticket_id,a.order_item_id,a.order_id,a.buyer_user_id,a.buyer_type,a.participant_id,
  a.holder_full_name,a.source,a.import_batch_id,a.issued_at,
  (select count(*) from public.ticket_holder_history h where h.ticket_id=a.ticket_id) holder_history_count,
  (select count(*) from public.audit_logs l where l.entity_type='tickets' and l.entity_id=a.ticket_id
    and l.action in('holder_assigned','ticket_transferred','admin_ticket_holder_transferred','admin_ticket_holder_changed','holder_removed')) holder_audit_count,
  case
    when exists(select 1 from public.ticket_holder_history h where h.ticket_id=a.ticket_id)
      or exists(select 1 from public.audit_logs l where l.entity_type='tickets' and l.entity_id=a.ticket_id
        and l.action in('holder_assigned','ticket_transferred','admin_ticket_holder_transferred','admin_ticket_holder_changed','holder_removed'))
      then 'TITULARIDADE MANUAL/TRANSFERIDA'
    when a.buyer_user_id is not null and exists(select 1 from public.participants p where p.id=a.participant_id and p.user_id=a.buyer_user_id)
      and a.issued_at is not null then 'AUTOATRIBUICAO COMPROVADA'
    else 'AMBIGUO'
  end holder_origin_classification
from conflicts c join active_holders a using(registration_contact_id,event_id)
join public.registration_contacts rc on rc.id=c.registration_contact_id
join public.events e on e.id=c.event_id
order by rc.full_name,e.name,a.issued_at,a.ticket_id;
