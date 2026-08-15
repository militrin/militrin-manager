-- MUTACAO CONTROLADA. NAO EXECUTAR antes de aplicar e validar a migration 137.
-- Defina explicitamente o operador autenticado da regularizacao na mesma transacao:
-- set local app.regularization_actor_user_id = 'UUID_DO_OPERADOR';

begin;

do $$
declare
  v_actor_text text:=current_setting('app.regularization_actor_user_id',true);
  v_actor uuid; v_event constant uuid:='6c931940-03ad-48c2-836c-754924a00d00';
  v_contact constant uuid:='91b9bc32-67d7-4ffb-8354-598b842bf559';
  v_participant constant uuid:='b2b4b9f2-1cab-452a-b76d-5380e631e348';
  v_buyer constant uuid:='e8f5777b-3ed1-409d-b3f1-71724be5a09e';
  v_keep constant uuid:='dec6d451-27c1-423d-8ac1-657ee8b0feb9';
  v_target record; v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_order public.orders%rowtype;
begin
  if v_actor_text is null or v_actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Defina app.regularization_actor_user_id com o UUID real do operador.';
  end if;
  v_actor:=v_actor_text::uuid;
  if not exists(select 1 from auth.users where id=v_actor) then raise exception 'Operador informado nao existe em auth.users.'; end if;

  -- O ticket preservado precisa continuar exatamente com Douglas.
  if not exists(
    select 1 from public.tickets t join public.order_items oi on oi.id=t.order_item_id
    join public.participants p on p.id=coalesce(oi.participant_id,t.participant_id)
    where t.id=v_keep and t.event_id=v_event and t.status not in('cancelled','canceled','void','voided')
      and p.id=v_participant and p.registration_contact_id=v_contact
  ) then raise exception 'Ticket preservado de Douglas divergiu do diagnostico; abortando.'; end if;

  for v_target in select * from (values
    ('901735bb-b32d-4633-b1da-6a14f07f2181'::uuid,'5ad7d0be-3226-4450-a015-631ccc72c65d'::uuid,'f7a26bf9-fe51-4ffc-82bd-e6492e84c6cf'::uuid),
    ('dff88449-a457-4609-bb36-ccb35c023889'::uuid,'081dc0ee-c5fa-4045-8023-907fcb7b11bb'::uuid,'5818658d-fbff-463b-b72b-97c35b7c10e8'::uuid)
  ) x(ticket_id,order_item_id,order_id)
  loop
    select * into strict v_ticket from public.tickets where id=v_target.ticket_id for update;
    select * into strict v_item from public.order_items where id=v_target.order_item_id for update;
    select * into strict v_order from public.orders where id=v_target.order_id for update;

    -- Retry comprovadamente concluido: nenhuma nova escrita.
    if v_ticket.participant_id is null and v_item.participant_id is null and v_item.registration_contact_id is null
      and exists(select 1 from public.ticket_holder_history h where h.ticket_id=v_ticket.id and h.operation='holder_removed'
        and h.previous_registration_contact_id=v_contact and h.new_registration_contact_id is null
        and h.reason='regularization_duplicate_autoassigned_holder')
    then continue; end if;

    if v_ticket.event_id<>v_event or v_item.event_id<>v_event or v_order.event_id<>v_event
      or v_ticket.order_item_id<>v_target.order_item_id or v_ticket.order_id<>v_target.order_id
      or v_item.order_id<>v_target.order_id then raise exception 'Cadeia esperada divergiu para ticket %.',v_ticket.id; end if;
    if v_ticket.status in('cancelled','canceled','void','voided') then raise exception 'Ticket % foi cancelado/anulado apos o diagnostico.',v_ticket.id; end if;
    if v_ticket.participant_id<>v_participant or v_item.participant_id<>v_participant
      or v_item.registration_contact_id not in(v_contact) then
      -- NULL e aceito porque era o estado legado diagnosticado; outro UUID nao e.
      if v_ticket.participant_id<>v_participant or v_item.participant_id<>v_participant or v_item.registration_contact_id is not null then
        raise exception 'Titular do ticket % mudou apos o diagnostico.',v_ticket.id;
      end if;
    end if;
    if not exists(select 1 from public.participants p where p.id=v_participant and p.registration_contact_id=v_contact and p.event_id=v_event) then
      raise exception 'Contato canonico de Douglas divergiu.';
    end if;
    if v_order.user_id<>v_buyer or v_order.participant_id<>v_participant or v_order.buyer_type<>'account' then
      raise exception 'Comprador/pedido do ticket % divergiu do diagnostico.',v_ticket.id;
    end if;
    if exists(select 1 from public.ticket_holder_history h where h.ticket_id=v_ticket.id) or exists(
      select 1 from public.audit_logs a where a.entity_type='tickets' and a.entity_id=v_ticket.id
        and a.action in('holder_assigned','ticket_transferred','admin_ticket_holder_transferred','admin_ticket_holder_changed','holder_removed')
    ) then raise exception 'Ticket % recebeu alteracao de titularidade posterior; revisao manual obrigatoria.',v_ticket.id; end if;

    update public.order_items set participant_id=null,registration_contact_id=null,holder_full_name=null,
      ownership_status='unassigned',updated_at=now() where id=v_item.id and participant_id=v_participant;
    if not found then raise exception 'Order item % mudou durante a regularizacao.',v_item.id; end if;
    -- O trigger canonico de order_items pode ja ter sincronizado tickets para NULL.
    update public.tickets set participant_id=null where id=v_ticket.id;
    if not found then raise exception 'Ticket % mudou durante a regularizacao.',v_ticket.id; end if;
    update public.participant_kit_items set participant_id=null where ticket_id=v_ticket.id and participant_id=v_participant;

    insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,
      previous_participant_id,new_participant_id,previous_registration_contact_id,new_registration_contact_id,
      previous_user_id,new_user_id,actor_user_id,actor_origin,reason)
    values(v_ticket.id,v_item.id,v_event,v_ticket.organization_id,'holder_removed',v_participant,null,v_contact,null,
      v_buyer,null,v_actor,'admin','regularization_duplicate_autoassigned_holder');
    insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
    values('holder_removed','tickets',v_ticket.id,v_event,jsonb_build_object(
      'operation','regularization_duplicate_autoassigned_holder','actor_user_id',v_actor,
      'previous_participant_id',v_participant,'previous_registration_contact_id',v_contact,
      'new_participant_id',null,'new_registration_contact_id',null,
      'preserved_order_id',v_order.id,'preserved_buyer_user_id',v_order.user_id));
  end loop;
end $$;

-- Inspecione este resultado antes de COMMIT. Troque por ROLLBACK diante de qualquer divergencia.
select t.id,t.status,t.participant_id,oi.participant_id order_item_participant_id,oi.registration_contact_id,
  oi.ownership_status,o.user_id buyer_user_id,o.payment_id,oi.ticket_category_id,oi.batch_id,oi.shirt_type,oi.shirt_size,t.token
from public.tickets t join public.order_items oi on oi.id=t.order_item_id join public.orders o on o.id=t.order_id
where t.id in('dec6d451-27c1-423d-8ac1-657ee8b0feb9','901735bb-b32d-4633-b1da-6a14f07f2181','dff88449-a457-4609-bb36-ccb35c023889')
order by t.issued_at,t.id;

commit;
