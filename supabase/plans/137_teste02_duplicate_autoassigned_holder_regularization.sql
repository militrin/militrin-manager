-- MUTACAO CONTROLADA. NAO EXECUTAR antes de aplicar e validar a migration 137.
-- Edite a linha SET abaixo com o UUID real do operador antes da execucao.
-- O script preserva integralmente compra, pedido, pagamento, categoria, lote e token.

begin;

-- set local app.regularization_actor_user_id = 'UUID_DO_OPERADOR';

do $$
declare
  v_actor_text text:=current_setting('app.regularization_actor_user_id',true); v_actor uuid;
  v_event constant uuid:='f84580c8-5537-4b38-992b-2c318c335b9f';
  v_contact constant uuid:='653bcb04-b712-492b-96c8-01cc3496ee33';
  v_participant constant uuid:='64703170-a1e9-4727-ac7b-c44b1c889db4';
  v_buyer constant uuid:='84fc74b5-095a-466f-a4dc-c52e4f3f2681';
  v_keep constant uuid:='21bc2f10-74c0-4383-a2c9-ddc87f7be74c';
  v_remove constant uuid:='c6caac5e-2598-453f-906e-d6456cefb82d';
  v_item_id constant uuid:='b2614a10-864e-47b9-b9a8-87b76d8f2c53';
  v_order_id constant uuid:='f9acef83-5fc2-473c-b81d-413a00b8284d';
  v_payment_id constant uuid:='cbdf9df0-fd9b-44e0-ae6c-6d014efbe7c6';
  v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_order public.orders%rowtype; v_payment public.payments%rowtype;
begin
  if v_actor_text is null or v_actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Defina app.regularization_actor_user_id com o UUID real do operador.';
  end if;
  v_actor:=v_actor_text::uuid;
  if not exists(select 1 from auth.users where id=v_actor) then raise exception 'Operador nao existe em auth.users.'; end if;

  perform 1 from public.tickets where id in(v_keep,v_remove) order by id for update;
  if (select count(*) from public.tickets where id in(v_keep,v_remove))<>2 then raise exception 'Conjunto de tickets divergiu.'; end if;
  select * into strict v_ticket from public.tickets where id=v_remove;
  select * into strict v_item from public.order_items where id=v_item_id for update;
  select * into strict v_order from public.orders where id=v_order_id for update;
  select * into strict v_payment from public.payments where id=v_payment_id for update;

  if v_ticket.participant_id is null and v_item.participant_id is null and v_item.registration_contact_id is null
    and exists(select 1 from public.ticket_holder_history h where h.ticket_id=v_remove and h.operation='holder_removed'
      and h.previous_registration_contact_id=v_contact and h.new_registration_contact_id is null
      and h.reason='regularization_duplicate_autoassigned_holder') then return; end if;

  if not exists(select 1 from public.tickets t join public.order_items oi on oi.id=t.order_item_id
    join public.participants p on p.id=oi.participant_id
    where t.id=v_keep and t.event_id=v_event and t.status='active' and p.id=v_participant
      and p.registration_contact_id=v_contact and p.user_id=v_buyer) then
    raise exception 'Ticket preservado divergiu do diagnostico.';
  end if;
  if v_ticket.event_id<>v_event or v_ticket.status<>'active' or v_ticket.order_id<>v_order_id
    or v_ticket.order_item_id<>v_item_id or v_ticket.participant_id<>v_participant
    or v_item.order_id<>v_order_id or v_item.event_id<>v_event or v_item.participant_id<>v_participant
    or v_item.registration_contact_id is not null or v_item.ticket_category_id<>'6d1ce61a-4712-41a3-a43a-f3f11ad0ff67'
    or v_item.batch_id<>'660d64df-52cb-4ed1-b721-6988f799dbb3' then
    raise exception 'Ticket excedente divergiu do diagnostico.';
  end if;
  if v_order.user_id<>v_buyer or v_order.participant_id<>v_participant or v_order.buyer_type<>'account'
    or v_order.payment_id<>v_payment_id or v_order.status<>'confirmed'
    or v_payment.order_id<>v_order_id or v_payment.payment_status<>'paid' or v_payment.payment_method<>'pix' then
    raise exception 'Comprador, pedido ou pagamento divergiram.';
  end if;
  if exists(select 1 from public.ticket_holder_history h where h.ticket_id=v_remove)
    or exists(select 1 from public.audit_logs a where a.entity_type='tickets' and a.entity_id=v_remove
      and a.action in('holder_assigned','ticket_transferred','admin_ticket_holder_transferred','admin_ticket_holder_changed','holder_removed')) then
    raise exception 'Titularidade recebeu alteracao posterior; revisao manual obrigatoria.';
  end if;
  if exists(select 1 from public.participant_kit_items pki where pki.ticket_id=v_remove and pki.delivered_at is not null)
    or exists(select 1 from public.audit_logs a where a.entity_type='tickets' and a.entity_id=v_remove
      and a.action in('ticket_checkin_entry','ticket_checkin_undo')) then
    raise exception 'Ticket recebeu check-in ou entrega posterior; revisao manual obrigatoria.';
  end if;

  update public.order_items set participant_id=null,registration_contact_id=null,holder_full_name=null,
    ownership_status='unassigned',updated_at=now() where id=v_item_id and participant_id=v_participant;
  if not found then raise exception 'Order item mudou durante a regularizacao.'; end if;
  -- O trigger canonico de order_items pode ja ter sincronizado tickets para NULL.
  update public.tickets set participant_id=null where id=v_remove;
  if not found then raise exception 'Ticket mudou durante a regularizacao.'; end if;
  update public.participant_kit_items set participant_id=null where ticket_id=v_remove and participant_id=v_participant;

  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,
    previous_participant_id,new_participant_id,previous_registration_contact_id,new_registration_contact_id,
    previous_user_id,new_user_id,actor_user_id,actor_origin,reason)
  values(v_remove,v_item_id,v_event,v_ticket.organization_id,'holder_removed',v_participant,null,v_contact,null,
    v_buyer,null,v_actor,'admin','regularization_duplicate_autoassigned_holder');
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('holder_removed','tickets',v_remove,v_event,jsonb_build_object(
    'operation','regularization_duplicate_autoassigned_holder','actor_user_id',v_actor,
    'previous_participant_id',v_participant,'previous_registration_contact_id',v_contact,
    'preserved_order_id',v_order_id,'preserved_payment_id',v_payment_id,'preserved_buyer_user_id',v_buyer));
end $$;

select t.id,t.status,t.participant_id,t.token,oi.participant_id order_item_participant_id,
  oi.registration_contact_id,oi.ownership_status,oi.ticket_category_id,oi.batch_id,o.user_id buyer_user_id,
  o.payment_id,pay.payment_status,pay.payment_method
from public.tickets t join public.order_items oi on oi.id=t.order_item_id
join public.orders o on o.id=t.order_id left join public.payments pay on pay.id=o.payment_id
where t.id in('21bc2f10-74c0-4383-a2c9-ddc87f7be74c','c6caac5e-2598-453f-906e-d6456cefb82d')
order by t.issued_at,t.id;

commit;
