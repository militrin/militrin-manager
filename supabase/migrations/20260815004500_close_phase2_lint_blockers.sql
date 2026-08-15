-- Fecha os seis bloqueadores funcionais encontrados pelo db lint na Fase 2.
begin;

create or replace function public.admin_update_payment_status(
  p_payment_id uuid,p_participant_id uuid,p_expected_current_status text,p_new_status text,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_payment public.payments%rowtype; v_order public.orders%rowtype;
  v_item public.order_items%rowtype; v_ticket_id uuid; v_item_count integer; v_valid text[]:=array['pending','paid','expired','cancelled','refunded'];
begin
  if v_actor is null then return jsonb_build_object('success',false,'message','Nao autenticado.'); end if;
  if p_new_status is null or not(p_new_status=any(v_valid)) then return jsonb_build_object('success',false,'message','Status invalido.'); end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null or length(trim(p_reason))<3 then return jsonb_build_object('success',false,'message','Motivo obrigatorio.'); end if;
  if p_new_status='refunded' then
    if not public.resolve_user_permission(v_actor,'finance.refund') then return jsonb_build_object('success',false,'message','Sem permissao para estornar pagamentos.'); end if;
  elsif not(public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'finance.confirm_payment')) then
    return jsonb_build_object('success',false,'message','Sem permissao para alterar status de pagamento.');
  end if;
  select * into v_payment from public.payments where id=p_payment_id and participant_id=p_participant_id for update;
  if not found then return jsonb_build_object('success',false,'message','Pagamento nao encontrado.'); end if;
  if not public.user_can_access_organization(v_actor,v_payment.organization_id) then return jsonb_build_object('success',false,'message','Sem acesso a organizacao do pagamento.'); end if;
  if v_payment.payment_status is distinct from p_expected_current_status then return jsonb_build_object('success',false,'message','O pagamento foi alterado. Recarregue e tente novamente.'); end if;
  if v_payment.payment_status=p_new_status then return jsonb_build_object('success',false,'message','O pagamento ja esta com esse status.'); end if;
  select * into v_order from public.orders where id=coalesce(v_payment.order_id,(select o.id from public.orders o where o.payment_id=v_payment.id limit 1)) for update;
  if not found then raise exception 'Pedido canonico do pagamento nao encontrado.'; end if;
  select count(*),(array_agg(oi.id order by oi.id))[1] into v_item_count,v_item.id from public.order_items oi where oi.order_id=v_order.id;
  if v_item_count<>1 then raise exception 'PAYMENT_ORDER_ITEM_CONTEXT_AMBIGUOUS'; end if;
  select * into strict v_item from public.order_items where id=v_item.id for update;
  if p_new_status in('pending','expired','cancelled') and exists(select 1 from public.tickets t where t.order_item_id=v_item.id and (t.status='used' or t.used_at is not null)) then
    return jsonb_build_object('success',false,'message','Ingresso ja utilizado; regressao de pagamento bloqueada.');
  end if;
  if p_new_status in('expired','cancelled','refunded') and exists(select 1 from public.participant_kit_items pki where pki.order_item_id=v_item.id and pki.status='delivered') then
    return jsonb_build_object('success',false,'message','Kit ja entregue; regressao de pagamento bloqueada.');
  end if;
  update public.payments set payment_status=p_new_status,paid_at=case when p_new_status='paid' then coalesce(paid_at,now()) else paid_at end,updated_at=now() where id=v_payment.id;
  update public.orders set status=case when p_new_status='paid' then 'confirmed' else p_new_status end,
    confirmed_at=case when p_new_status='paid' then coalesce(confirmed_at,now()) else confirmed_at end,
    cancelled_at=case when p_new_status in('cancelled','refunded') then coalesce(cancelled_at,now()) else cancelled_at end where id=v_order.id;
  update public.order_items set status=case when p_new_status='paid' then 'confirmed' when p_new_status='pending' then 'reserved' else p_new_status end,
    reservation_expires_at=case when p_new_status='paid' then null else reservation_expires_at end,updated_at=now() where id=v_item.id;
  if p_new_status='paid' then v_ticket_id:=public.confirm_order_item_and_issue_ticket(v_item.id);
  elsif p_new_status in('expired','cancelled','refunded') then update public.tickets set status='cancelled',cancelled_at=coalesce(cancelled_at,now()) where order_item_id=v_item.id returning id into v_ticket_id;
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('payment_status_changed','payments',v_payment.id,v_payment.event_id,
    jsonb_build_object('actor_user_id',v_actor,'organization_id',v_payment.organization_id,'participant_projection_id',p_participant_id,
      'order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket_id,'previous_status',v_payment.payment_status,
      'new_status',p_new_status,'reason',trim(p_reason),'source','canonical_payment_admin'));
  return jsonb_build_object('success',true,'message','Status de pagamento atualizado.','order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket_id);
end; $$;

create or replace function public.assign_order_item_participant(p_order_item_id uuid,p_participant_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_participant public.participants%rowtype; v_contact public.registration_contacts%rowtype; v_ticket_id uuid; v_previous uuid;
begin
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into strict v_order from public.orders where id=v_item.order_id for update;
  if v_actor is null or (v_order.user_id is distinct from v_actor and not(
    public.user_can_access_organization(v_actor,v_order.organization_id)
    and public.resolve_user_permission(v_actor,'participants.edit_basic')
  )) then raise exception 'Usuario sem permissao para atribuir este ingresso.'; end if;
  select * into v_participant from public.participants where id=p_participant_id for update;
  if not found or v_participant.event_id is distinct from v_item.event_id then raise exception 'Participante invalido para o evento do ingresso.'; end if;
  if v_participant.registration_contact_id is null then raise exception 'Participante sem cadastro global vinculado.'; end if;
  select * into strict v_contact from public.registration_contacts where id=v_participant.registration_contact_id and organization_id=v_order.organization_id;
  perform public.assert_ticket_holder_contact_available(null,v_item.event_id,v_contact.id);
  v_previous:=v_item.participant_id;
  update public.order_items set participant_id=v_participant.id,registration_contact_id=v_contact.id,holder_full_name=v_contact.full_name,
    ownership_status='assigned',updated_at=now() where id=v_item.id returning * into v_item;
  select id into v_ticket_id from public.tickets where order_item_id=v_item.id for update;
  if v_item.status='confirmed' then
    v_ticket_id:=public.confirm_order_item_and_issue_ticket(v_item.id);
    update public.tickets set participant_id=v_participant.id where id=v_ticket_id;
  elsif v_ticket_id is not null then update public.tickets set participant_id=v_participant.id where id=v_ticket_id; end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_holder_assigned',case when v_ticket_id is null then 'order_items' else 'tickets' end,
    coalesce(v_ticket_id,v_item.id),v_item.event_id,jsonb_build_object('actor_user_id',v_actor,'order_id',v_order.id,'order_item_id',v_item.id,
      'ticket_id',v_ticket_id,'previous_participant_id',v_previous,'participant_id',v_participant.id,'registration_contact_id',v_contact.id));
  return v_ticket_id;
end; $$;

create or replace function public.checkin_ticket_entry(p_ticket_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_participant public.participants%rowtype; v_contact public.registration_contacts%rowtype; v_paid boolean; v_actor_email text;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para realizar check-in.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado. Check-in bloqueado.'; end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Este ingresso ja foi utilizado.'; end if;
  select * into v_item from public.order_items where id=v_ticket.order_item_id for update;
  if not found or v_item.status in('cancelled','expired','refunded') then raise exception 'Item de pedido invalido para check-in.'; end if;
  select * into strict v_order from public.orders where id=v_ticket.order_id;
  select exists(select 1 from public.payments p where (p.order_id=v_order.id or p.id=v_order.payment_id) and p.payment_status='paid') into v_paid;
  if not v_paid then raise exception 'Pagamento pendente. Check-in bloqueado.'; end if;
  update public.tickets set status='used',used_at=now() where id=v_ticket.id;
  if v_item.participant_id is not null then
    select * into v_participant from public.participants where id=v_item.participant_id;
    if found and v_participant.registration_contact_id is not null then select * into v_contact from public.registration_contacts where id=v_participant.registration_contact_id; end if;
    if found and v_participant.user_id is not null then
      insert into public.participation_history(event_id,user_id,participant_id,registration_contact_id,legacy_event_name,event_year,full_name,normalized_name,cpf,email,status,source,manually_verified,created_at,updated_at)
      values(v_ticket.event_id,v_participant.user_id,v_participant.id,v_participant.registration_contact_id,null,extract(year from coalesce(v_ticket.issued_at,now()))::integer,
        coalesce(v_contact.full_name,v_participant.full_name,'Participante'),public.normalize_text_for_match(coalesce(v_contact.full_name,v_participant.full_name)),
        coalesce(v_contact.cpf,v_participant.cpf),coalesce(v_contact.email,v_participant.email),'confirmed','system',false,now(),now()) on conflict do nothing;
      -- Loyalty nao existe neste schema reconciliado. O historico e persistido
      -- como fato canonico e um modulo futuro pode recalcula-lo assincronamente.
    end if;
  end if;
  select lower(email) into v_actor_email from auth.users where id=auth.uid();
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_checkin_entry','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'actor_email',v_actor_email,'organization_id',v_ticket.organization_id,'ticket_id',v_ticket.id,
      'order_item_id',v_ticket.order_item_id,'participant_id',v_item.participant_id,'registration_contact_id',v_item.registration_contact_id,'used_at',now()));
  return true;
end; $$;

-- Wrapper legado ticket-first. Remove a dependencia obrigatoria de loyalty do
-- caminho antigo sem duplicar a regra de check-in.
create or replace function public.checkin_participant_entry(p_participant_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ticket_id uuid;
begin
  v_ticket_id:=public.resolve_unique_ticket_for_participant(p_participant_id);
  return public.checkin_ticket_entry(v_ticket_id);
end; $$;

create or replace function public.deliver_kit_and_checkin(p_ticket_id uuid)
returns table(success boolean,kit_delivered boolean,checkin_done boolean,message text,participant_id uuid,event_id uuid)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_event public.events%rowtype; v_pending integer; v_paid boolean;
begin
  if not public.current_user_has_permission('kits.deliver') or not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para operacao combinada.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  select * into strict v_event from public.events where id=v_ticket.event_id;
  if not coalesce(v_event.allow_checkin_during_kit_delivery,false) then
    return query select false,false,false,'Operacao combinada desativada para este evento.'::text,v_item.participant_id,v_ticket.event_id; return;
  end if;
  select exists(select 1 from public.payments p where p.order_id=v_ticket.order_id and p.payment_status='paid') into v_paid;
  if not v_paid then return query select false,false,false,'Pagamento pendente.'::text,v_item.participant_id,v_ticket.event_id; return; end if;
  perform public.ensure_ticket_kit_items(v_ticket.id);
  select count(*) into v_pending from public.participant_kit_items pki where pki.ticket_id=v_ticket.id and pki.status<>'delivered';
  if v_pending>0 then perform public.deliver_ticket_full_kit(v_ticket.id); end if;
  if v_ticket.status<>'used' and v_ticket.used_at is null then perform public.checkin_ticket_entry(v_ticket.id); end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('combined_kit_delivery_and_checkin','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',v_ticket.id,'order_item_id',v_item.id,'participant_id',v_item.participant_id));
  return query select true,true,true,'Kit entregue e entrada registrada.'::text,v_item.participant_id,v_ticket.event_id;
end; $$;

create or replace function public.redeem_coupon(p_coupon_id uuid,p_participant_id uuid,p_event_id uuid,p_original_amount numeric)
returns table(discount_amount numeric,final_amount numeric,payment_status text,message text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_coupon public.coupons%rowtype; v_payment public.payments%rowtype;
  v_order public.orders%rowtype; v_item public.order_items%rowtype; v_discount numeric; v_final numeric; v_count integer; v_status text;
begin
  if p_coupon_id is null or p_participant_id is null or p_event_id is null or p_original_amount is null or p_original_amount<0 then raise exception 'Parametros invalidos para resgate.'; end if;
  select * into v_coupon from public.coupons where id=p_coupon_id and event_id=p_event_id for update;
  if not found or not v_coupon.is_active or (v_coupon.valid_from is not null and now()<v_coupon.valid_from) or (v_coupon.valid_until is not null and now()>v_coupon.valid_until) then raise exception 'Cupom indisponivel.'; end if;
  if v_coupon.max_uses is not null and v_coupon.used_count>=v_coupon.max_uses then raise exception 'Limite de usos atingido.'; end if;
  if exists(select 1 from public.coupon_redemptions cr where cr.coupon_id=p_coupon_id and cr.participant_id=p_participant_id) then raise exception 'Cupom ja utilizado por este cadastro.'; end if;
  perform 1 from public.participants where id=p_participant_id and event_id=p_event_id;
  if not found then raise exception 'Projecao do cadastro nao encontrada.'; end if;
  select count(*),(array_agg(p.id order by p.id))[1] into v_count,v_payment.id from public.payments p where p.participant_id=p_participant_id and p.event_id=p_event_id;
  if v_count<>1 then raise exception 'COUPON_PAYMENT_CONTEXT_AMBIGUOUS'; end if;
  select * into strict v_payment from public.payments where id=v_payment.id for update;
  select * into v_order from public.orders where id=coalesce(v_payment.order_id,(select o.id from public.orders o where o.payment_id=v_payment.id limit 1)) for update;
  if not found then raise exception 'Pedido canonico nao encontrado.'; end if;
  select count(*),(array_agg(oi.id order by oi.id))[1] into v_count,v_item.id from public.order_items oi where oi.order_id=v_order.id;
  if v_count<>1 then raise exception 'COUPON_ORDER_ITEM_CONTEXT_AMBIGUOUS'; end if;
  select * into strict v_item from public.order_items where id=v_item.id for update;
  if v_coupon.coupon_type='courtesy' then v_discount:=round(p_original_amount,2); v_final:=0; v_status:='paid';
  else v_discount:=round(p_original_amount*coalesce(v_coupon.discount_percent,0)/100.0,2); v_final:=round(greatest(0,p_original_amount-v_discount),2); v_status:='pending'; end if;
  update public.coupons set used_count=used_count+1,updated_at=now() where id=v_coupon.id;
  insert into public.coupon_redemptions(coupon_id,participant_id,event_id,original_amount,discount_amount,final_amount)
    values(v_coupon.id,p_participant_id,p_event_id,p_original_amount,v_discount,v_final);
  update public.payments set amount=p_original_amount,discount_amount=v_discount,final_amount=v_final,
    payment_method=case when v_status='paid' then 'courtesy' else payment_method end,payment_status=v_status,
    paid_at=case when v_status='paid' then coalesce(paid_at,now()) else null end,updated_at=now() where id=v_payment.id;
  update public.orders set base_amount=p_original_amount,discount_amount=v_discount,final_amount=v_final,status=case when v_status='paid' then 'confirmed' else 'pending' end,
    confirmed_at=case when v_status='paid' then coalesce(confirmed_at,now()) else confirmed_at end where id=v_order.id;
  update public.order_items set unit_price=p_original_amount,discount_amount=v_discount,final_amount=v_final,status=case when v_status='paid' then 'confirmed' else 'reserved' end,
    reservation_expires_at=case when v_status='paid' then null else reservation_expires_at end,updated_at=now() where id=v_item.id;
  if v_status='paid' then perform public.confirm_order_item_and_issue_ticket(v_item.id); end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('coupon_redeemed','payments',v_payment.id,p_event_id,
    jsonb_build_object('coupon_id',v_coupon.id,'coupon_code',v_coupon.code,'participant_projection_id',p_participant_id,'payment_id',v_payment.id,
      'order_id',v_order.id,'order_item_id',v_item.id,'original_amount',p_original_amount,'discount_amount',v_discount,'final_amount',v_final));
  return query select v_discount,v_final,v_status,case when v_status='paid' then 'Cortesia aplicada e pagamento confirmado.' else 'Cupom aplicado com sucesso.' end;
end; $$;

-- A emissao manual passa a criar/reutilizar o contato global e mantem a
-- projecao event-scoped apenas para consumidores legados.
create or replace function public.create_manual_registration_order(
  p_event_id uuid,p_ticket_category_id uuid,p_batch_id uuid,p_full_name text,p_cpf text,p_birth_date date,p_gender text,
  p_phone text,p_email text,p_city text,p_shirt_type text,p_shirt_size text,p_payment_method text,p_notes text default null
) returns table(participant_id uuid,order_id uuid,order_item_id uuid,payment_id uuid,ticket_id uuid,full_name text,batch_name text,
  base_amount numeric,discount_amount numeric,final_amount numeric,payment_status text,reservation_expires_at timestamptz,shirt_type text,shirt_size text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_event public.events%rowtype; v_contact public.registration_contacts%rowtype; v_contact_result jsonb;
  v_participant public.participants%rowtype; v_order public.orders%rowtype; v_item public.order_items%rowtype; v_payment public.payments%rowtype;
  v_base numeric; v_batch_name text; v_ticket uuid; v_type text:=nullif(trim(coalesce(p_shirt_type,'')),''); v_size text:=nullif(trim(coalesce(p_shirt_size,'')),'');
begin
  if v_actor is null or not public.current_user_has_permission('participants.create') then raise exception 'Sem permissao para criar inscricao manual.'; end if;
  select * into v_event from public.events where id=p_event_id;
  if not found or not public.user_can_access_organization(v_actor,v_event.organization_id) then raise exception 'Evento invalido ou sem acesso.'; end if;
  if not exists(select 1 from public.ticket_categories tc where tc.id=p_ticket_category_id and tc.event_id=p_event_id and tc.is_active) then raise exception 'Categoria invalida.'; end if;
  select rb.name into v_batch_name from public.registration_batches rb where rb.id=p_batch_id and rb.event_id=p_event_id;
  if not found then raise exception 'Lote invalido.'; end if;
  select case when lower(trim(coalesce(p_gender,''))) in('feminino','female','f') then rbp.female_price else rbp.male_price end into v_base
    from public.registration_batch_prices rbp where rbp.batch_id=p_batch_id and rbp.ticket_category_id=p_ticket_category_id;
  if v_base is null then raise exception 'Preco nao configurado.'; end if;
  if exists(select 1 from public.event_kit_items eki where eki.event_id=p_event_id and eki.item_type='shirt' and eki.is_active) and (v_type is null or v_size is null) then raise exception 'Camiseta obrigatoria.'; end if;
  v_contact_result:=public.resolve_import_registration_contact(v_event.organization_id,null,p_full_name,p_cpf,p_birth_date,p_gender,p_phone,p_email,p_city);
  select * into strict v_contact from public.registration_contacts where id=(v_contact_result->>'registration_contact_id')::uuid for update;
  select * into v_participant from public.participants p where p.event_id=p_event_id and p.registration_contact_id=v_contact.id for update;
  if not found then
    insert into public.participants(event_id,organization_id,registration_contact_id,full_name,cpf,birth_date,gender,phone,email,city,registration_status,reservation_status,notes)
    values(p_event_id,v_event.organization_id,v_contact.id,v_contact.full_name,v_contact.cpf,v_contact.birth_date,v_contact.gender,v_contact.phone,v_contact.email,v_contact.city,
      'pending','pending',nullif(trim(coalesce(p_notes,'')),'')) returning * into v_participant;
  end if;
  insert into public.orders(user_id,participant_id,event_id,organization_id,order_number,status,base_amount,discount_amount,final_amount,buyer_type,confirmed_at)
    values(v_actor,v_participant.id,p_event_id,v_event.organization_id,public.generate_order_number(),'confirmed',v_base,v_base,0,'account',now()) returning * into v_order;
  insert into public.order_items(order_id,event_id,participant_id,registration_contact_id,ownership_status,holder_full_name,ticket_category_id,batch_id,shirt_type,shirt_size,
    quantity,unit_price,discount_amount,final_amount,status) values(v_order.id,p_event_id,v_participant.id,v_contact.id,'assigned',v_contact.full_name,p_ticket_category_id,p_batch_id,
    v_type,v_size,1,v_base,v_base,0,'confirmed') returning * into v_item;
  insert into public.payments(participant_id,event_id,organization_id,order_id,amount,discount_amount,final_amount,payment_method,payment_status,paid_at)
    values(v_participant.id,p_event_id,v_event.organization_id,v_order.id,v_base,v_base,0,lower(trim(p_payment_method)),'paid',now()) returning * into v_payment;
  update public.orders set payment_id=v_payment.id where id=v_order.id;
  v_ticket:=public.confirm_order_item_and_issue_ticket(v_item.id);
  perform public.ensure_ticket_kit_items(v_ticket);
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('manual_registration_order_created','orders',v_order.id,p_event_id,
    jsonb_build_object('actor_user_id',v_actor,'registration_contact_id',v_contact.id,'participant_projection_id',v_participant.id,'order_item_id',v_item.id,
      'ticket_category_id',p_ticket_category_id,'batch_id',p_batch_id,'payment_id',v_payment.id,'ticket_id',v_ticket,'category_owner','order_items'));
  return query select v_participant.id,v_order.id,v_item.id,v_payment.id,v_ticket,v_contact.full_name,v_batch_name,v_base,v_base,0::numeric,
    v_payment.payment_status,null::timestamptz,coalesce(v_item.shirt_type,''),coalesce(v_item.shirt_size,'');
end; $$;

revoke all on function public.admin_update_payment_status(uuid,uuid,text,text,text),public.assign_order_item_participant(uuid,uuid),
  public.checkin_ticket_entry(uuid),public.deliver_kit_and_checkin(uuid),public.redeem_coupon(uuid,uuid,uuid,numeric) from public,anon;
grant execute on function public.admin_update_payment_status(uuid,uuid,text,text,text),public.assign_order_item_participant(uuid,uuid),
  public.checkin_ticket_entry(uuid),public.redeem_coupon(uuid,uuid,uuid,numeric) to authenticated,service_role;
revoke all on function public.deliver_kit_and_checkin(uuid) from authenticated;
grant execute on function public.deliver_kit_and_checkin(uuid) to service_role;

commit;
