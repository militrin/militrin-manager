-- 136_137_final_preflight.sql
-- SOMENTE LEITURA. Execute antes de aplicar 136 e 137.

-- 1. Integridade fisica do estoque.
select id,event_id,kit_item_id,variant_id,total_quantity,reserved_quantity,delivered_quantity,
  total_quantity-delivered_quantity physical_available
from public.event_kit_item_variant_inventory
where delivered_quantity>total_quantity or total_quantity<0 or reserved_quantity<0 or delivered_quantity<0
order by event_id,kit_item_id,variant_id;

select kit_item_id,variant_id,count(*) duplicate_count,array_agg(id order by id) inventory_ids
from public.event_kit_item_variant_inventory
group by kit_item_id,variant_id having count(*)>1;

-- 2. Camisetas materializadas sem variante canônica.
select pki.id participant_kit_item_id,pki.ticket_id,pki.order_item_id,pki.kit_item_id,pki.status,
  pki.variant_data,oi.shirt_type,oi.shirt_size
from public.participant_kit_items pki
join public.event_kit_items eki on eki.id=pki.kit_item_id and eki.item_type='shirt'
left join public.order_items oi on oi.id=pki.order_item_id
where pki.ticket_id is not null and nullif(pki.variant_data->>'variant_id','') is null
order by pki.ticket_id,pki.id;

-- 3. Tickets com camiseta configurada cuja materialização não é determinística.
select t.id ticket_id,t.event_id,t.order_item_id,oi.shirt_type,oi.shirt_size,eki.id kit_item_id,
  count(v.id) matching_active_variants,
  case when pki.id is null then 'NOT_MATERIALIZED'
    when nullif(pki.variant_data->>'variant_id','') is null then 'MATERIALIZED_WITHOUT_VARIANT_ID'
    when count(v.id)<>1 then 'VARIANT_NOT_DETERMINISTIC' else 'OK' end diagnosis
from public.tickets t
join public.order_items oi on oi.id=t.order_item_id
join public.event_kit_items eki on eki.event_id=t.event_id and eki.item_type='shirt' and eki.is_active
left join public.event_kit_item_variants v on v.kit_item_id=eki.id and v.is_active
  and v.name=trim(oi.shirt_type) and v.value=trim(oi.shirt_size)
left join public.participant_kit_items pki on pki.ticket_id=t.id and pki.kit_item_id=eki.id
where t.status not in('cancelled','canceled','void','voided')
  and nullif(trim(oi.shirt_type),'') is not null and nullif(trim(oi.shirt_size),'') is not null
group by t.id,t.event_id,t.order_item_id,oi.shirt_type,oi.shirt_size,eki.id,pki.id,pki.variant_data
having pki.id is null or nullif(pki.variant_data->>'variant_id','') is null or count(v.id)<>1
order by t.event_id,t.id;

-- 4. Duplicidade de titular ativo por identidade global.
with active_holders as (
  select t.id ticket_id,t.event_id,coalesce(oi.registration_contact_id,p.registration_contact_id) registration_contact_id
  from public.tickets t join public.order_items oi on oi.id=t.order_item_id
  left join public.participants p on p.id=coalesce(oi.participant_id,t.participant_id)
  where t.status not in('cancelled','canceled','void','voided')
)
select registration_contact_id,event_id,count(*) ticket_count,array_agg(ticket_id order by ticket_id) ticket_ids
from active_holders where registration_contact_id is not null
group by registration_contact_id,event_id having count(*)>1;

-- 5. Titulares sem contato e divergências da cadeia operacional.
select t.id ticket_id,t.event_id,t.participant_id ticket_participant_id,oi.participant_id order_item_participant_id,
  oi.registration_contact_id order_item_contact_id,tp.registration_contact_id ticket_participant_contact_id,
  op.registration_contact_id order_item_participant_contact_id,
  case
    when coalesce(t.participant_id,oi.participant_id) is not null and coalesce(oi.registration_contact_id,tp.registration_contact_id,op.registration_contact_id) is null then 'HOLDER_WITHOUT_CONTACT'
    when t.participant_id is distinct from oi.participant_id then 'PARTICIPANT_DIVERGENCE'
    when oi.registration_contact_id is not null and oi.registration_contact_id is distinct from coalesce(op.registration_contact_id,tp.registration_contact_id) then 'CONTACT_DIVERGENCE'
  end diagnosis
from public.tickets t join public.order_items oi on oi.id=t.order_item_id
left join public.participants tp on tp.id=t.participant_id
left join public.participants op on op.id=oi.participant_id
where (coalesce(t.participant_id,oi.participant_id) is not null and coalesce(oi.registration_contact_id,tp.registration_contact_id,op.registration_contact_id) is null)
   or t.participant_id is distinct from oi.participant_id
   or (oi.registration_contact_id is not null and oi.registration_contact_id is distinct from coalesce(op.registration_contact_id,tp.registration_contact_id));

-- 6. Estado do schema legado do histórico. Esperado antes da 137: new_user_id ainda NOT NULL.
select column_name,is_nullable,data_type
from information_schema.columns
where table_schema='public' and table_name='ticket_holder_history'
  and column_name in('previous_registration_contact_id','new_registration_contact_id','previous_user_id','new_user_id','actor_user_id')
order by column_name;

-- 7. Backfill determinístico e ambiguidades que não podem ser preenchidas automaticamente.
select h.id,h.ticket_id,h.previous_participant_id,h.new_participant_id,
  oldp.registration_contact_id deterministic_previous_contact_id,
  newp.registration_contact_id deterministic_new_contact_id,
  case
    when h.previous_participant_id is not null and oldp.registration_contact_id is null then 'AMBIGUOUS_PREVIOUS_CONTACT'
    when h.new_participant_id is not null and newp.registration_contact_id is null then 'AMBIGUOUS_NEW_CONTACT'
    else 'DETERMINISTIC_BACKFILL'
  end backfill_classification
from public.ticket_holder_history h
left join public.participants oldp on oldp.id=h.previous_participant_id
left join public.participants newp on newp.id=h.new_participant_id
order by h.created_at,h.id;

-- 8. Assinaturas instaladas que 136/137 substituem ou delegam.
select p.oid::regprocedure signature,pg_get_functiondef(p.oid) definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in(
  'deliver_ticket_kit_item','deliver_ticket_full_kit','deliver_items_and_checkin',
  'admin_change_ticket_shirt','materialize_ticket_kit_items_internal',
  'admin_transfer_ticket_holder','admin_set_ticket_holder_contact','ensure_ticket_kit_items'
)
order by signature::text;
