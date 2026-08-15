-- SOMENTE LEITURA. Execute depois de 136, 137 e da regularização aprovada.

select id,event_id,kit_item_id,variant_id,total_quantity,reserved_quantity,delivered_quantity,
  total_quantity-delivered_quantity physical_available
from public.event_kit_item_variant_inventory
where delivered_quantity>total_quantity or total_quantity<0 or reserved_quantity<0 or delivered_quantity<0;

select t.id,t.status,t.order_id,t.order_item_id,t.participant_id,oi.participant_id order_item_participant_id,
  oi.registration_contact_id,oi.ownership_status,oi.holder_full_name,o.user_id buyer_user_id,o.payment_id,
  oi.ticket_category_id,oi.batch_id,oi.shirt_type,oi.shirt_size,t.token
from public.tickets t join public.order_items oi on oi.id=t.order_item_id join public.orders o on o.id=t.order_id
where t.id in('dec6d451-27c1-423d-8ac1-657ee8b0feb9','901735bb-b32d-4633-b1da-6a14f07f2181','dff88449-a457-4609-bb36-ccb35c023889')
order by t.issued_at,t.id;

select ticket_id,operation,previous_registration_contact_id,new_registration_contact_id,
  previous_user_id,new_user_id,actor_user_id,actor_origin,reason,created_at
from public.ticket_holder_history
where ticket_id in('901735bb-b32d-4633-b1da-6a14f07f2181','dff88449-a457-4609-bb36-ccb35c023889')
order by created_at,id;

select ticket_id,kit_item_id,participant_id,order_item_id,status,variant_data,delivered_at
from public.participant_kit_items
where ticket_id in('dec6d451-27c1-423d-8ac1-657ee8b0feb9','901735bb-b32d-4633-b1da-6a14f07f2181','dff88449-a457-4609-bb36-ccb35c023889')
order by ticket_id,kit_item_id;
