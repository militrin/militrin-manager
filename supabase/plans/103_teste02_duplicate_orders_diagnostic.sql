-- 103_teste02_duplicate_orders_diagnostic.sql
-- Somente leitura: diagnostica os dois pedidos existentes associados a teste02.

with target_users as (
  select au.id as user_id,au.email
  from auth.users au
  where lower(coalesce(au.email,'')) like '%teste02%'
), target_participants as (
  select p.* from public.participants p
  where p.user_id in(select user_id from target_users)
    or lower(coalesce(p.email,'')) like '%teste02%'
), target_orders as (
  select o.* from public.orders o
  where o.user_id in(select user_id from target_users)
    or o.participant_id in(select id from target_participants)
), target_items as (
  select oi.* from public.order_items oi where oi.order_id in(select id from target_orders)
), target_tickets as (
  select t.* from public.tickets t
  where t.order_item_id in(select id from target_items)
     or t.order_id in(select id from target_orders)
     or t.participant_id in(select id from target_participants)
), diagnostic_stats as (
  select count(*)::integer as distinct_order_count from target_orders
)
select
  o.id as order_id,o.order_number,o.status as order_status,o.event_id,o.organization_id,
  o.participant_id,o.user_id,o.payment_id,o.buyer_type,o.import_batch_id,
  p.id as payment_record_id,p.payment_status,p.amount,p.final_amount,
  oi.id as order_item_id,oi.status as order_item_status,oi.batch_id as commercial_batch_id,
  oi.participant_id as order_item_participant_id,
  t.id as ticket_id,t.status as ticket_status,t.order_item_id as ticket_order_item_id,
  count(*) over() as diagnostic_row_count,
  ds.distinct_order_count
from target_orders o
cross join diagnostic_stats ds
left join public.payments p on p.id=o.payment_id
left join target_items oi on oi.order_id=o.id
left join target_tickets t on t.order_item_id=oi.id or (t.order_item_id is null and t.order_id=o.id)
order by o.created_at,o.id,oi.created_at,oi.id,t.issued_at,t.id;
