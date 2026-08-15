-- SOMENTE LEITURA. Diagnostico auditavel dos contatos remanescentes.
-- Nao executa funcoes, nao bloqueia linhas e nao altera dados.
with target_contacts(id) as (values
  ('653bcb04-b712-492b-96c8-01cc3496ee33'::uuid),
  ('bfc527b0-9083-4644-9d4a-d5b36983aae8'::uuid)
), holder_tickets as (
  select rc.id registration_contact_id,rc.full_name contact_name,e.id event_id,e.name event_name,
    t.id ticket_id,t.issued_at,t.status ticket_status,t.token,t.order_id,t.order_item_id,
    o.created_at order_created_at,o.user_id buyer_user_id,o.buyer_type,o.participant_id buyer_participant_id,o.payment_id,
    oi.participant_id holder_participant_id,oi.registration_contact_id order_item_contact_id,
    oi.holder_full_name,oi.ownership_status,oi.ticket_category_id,tc.name category_name,
    oi.batch_id,rb.name batch_name,oi.shirt_type,oi.shirt_size,p.user_id holder_user_id,
    pay.payment_method,pay.payment_status
  from target_contacts x join public.registration_contacts rc on rc.id=x.id
  join public.participants p on p.registration_contact_id=rc.id
  join public.tickets t on t.participant_id=p.id
  join public.order_items oi on oi.id=t.order_item_id
  join public.orders o on o.id=t.order_id
  join public.events e on e.id=t.event_id
  left join public.ticket_categories tc on tc.id=oi.ticket_category_id
  left join public.registration_batches rb on rb.id=oi.batch_id
  left join public.payments pay on pay.id=o.payment_id
)
select h.*,
  (select count(*) from public.ticket_holder_history th where th.ticket_id=h.ticket_id) holder_history_count,
  (select coalesce(jsonb_agg(jsonb_build_object('operation',th.operation,'created_at',th.created_at,
    'previous_participant_id',th.previous_participant_id,'new_participant_id',th.new_participant_id,
    'previous_user_id',th.previous_user_id,'new_user_id',th.new_user_id,'actor_user_id',th.actor_user_id,
    'actor_origin',th.actor_origin,'reason',th.reason) order by th.created_at),'[]'::jsonb)
   from public.ticket_holder_history th where th.ticket_id=h.ticket_id) holder_history,
  (select coalesce(jsonb_agg(jsonb_build_object('entity_type',a.entity_type,'entity_id',a.entity_id,
    'action',a.action,'created_at',a.created_at,'details',a.details) order by a.created_at),'[]'::jsonb)
   from public.audit_logs a where a.entity_id in(h.ticket_id,h.order_id,h.order_item_id,h.holder_participant_id,h.payment_id)) audit_trail,
  (select coalesce(jsonb_agg(jsonb_build_object('source',ph.source,'import_batch_id',ph.import_batch_id,
    'status',ph.status,'created_at',ph.created_at) order by ph.created_at),'[]'::jsonb)
   from public.participation_history ph where ph.participant_id=h.holder_participant_id and ph.event_id=h.event_id) participation_origins,
  (select count(*) from public.participant_kit_items pki where pki.ticket_id=h.ticket_id) kit_item_count,
  (select count(*) from public.participant_kit_items pki where pki.ticket_id=h.ticket_id and pki.delivered_at is not null) delivered_kit_item_count,
  (select coalesce(jsonb_agg(jsonb_build_object('action',a.action,'created_at',a.created_at,'details',a.details)
    order by a.created_at),'[]'::jsonb) from public.audit_logs a
    where a.entity_type='tickets' and a.entity_id=h.ticket_id and a.action in('ticket_checkin_entry','ticket_checkin_undo')) checkin_audit
from holder_tickets h order by h.contact_name,h.event_name,h.issued_at,h.ticket_id;

