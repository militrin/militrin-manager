-- redeem_coupon (RPC legada do fluxo de ingresso unico -- sem consumidores
-- vivos em src/, mas ainda exercitada por
-- tests/contact-first-phase2.integration.mjs, que valida uma cadeia real de
-- negocio: cortesia -> pagamento confirmado -> ticket -> checkin) ainda lia
-- coupon_type/discount_percent, colunas removidas na migration de
-- reorganizacao de cupons (superadas por discount_type/discount_value).
-- Ajustada para o novo schema, preservando exatamente o mesmo contrato e
-- comportamento observavel (cortesia = discount_type='percentage' com
-- discount_value=100, tratada como pagamento imediato).
begin;

create or replace function public.redeem_coupon(p_coupon_id uuid, p_participant_id uuid, p_event_id uuid, p_original_amount numeric)
 RETURNS TABLE(discount_amount numeric, final_amount numeric, payment_status text, message text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_coupon public.coupons%rowtype; v_payment public.payments%rowtype;
  v_order public.orders%rowtype; v_item public.order_items%rowtype; v_discount numeric; v_final numeric; v_count integer; v_status text;
  v_org uuid;
begin
  if p_coupon_id is null or p_participant_id is null or p_event_id is null or p_original_amount is null or p_original_amount<0 then raise exception 'Parametros invalidos para resgate.'; end if;
  select organization_id into v_org from public.events where id=p_event_id;
  if v_org is null then raise exception 'Evento invalido.'; end if;
  select * into v_coupon from public.coupons where id=p_coupon_id and organization_id=v_org for update;
  if not found or not v_coupon.is_active or not v_coupon.applies_to_tickets or (v_coupon.valid_from is not null and now()<v_coupon.valid_from) or (v_coupon.valid_until is not null and now()>v_coupon.valid_until) then raise exception 'Cupom indisponivel.'; end if;
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
  if v_coupon.discount_type='percentage' and v_coupon.discount_value=100 then v_discount:=round(p_original_amount,2); v_final:=0; v_status:='paid';
  elsif v_coupon.discount_type='percentage' then v_discount:=round(p_original_amount*coalesce(v_coupon.discount_value,0)/100.0,2); v_final:=round(greatest(0,p_original_amount-v_discount),2); v_status:='pending';
  else v_discount:=round(least(coalesce(v_coupon.discount_value,0),p_original_amount),2); v_final:=round(greatest(0,p_original_amount-v_discount),2); v_status:='pending'; end if;
  update public.coupons set used_count=used_count+1,updated_at=now() where id=v_coupon.id;
  insert into public.coupon_redemptions(coupon_id,participant_id,event_id,original_amount,discount_amount,final_amount)
    values(v_coupon.id,p_participant_id,p_event_id,p_original_amount,v_discount,v_final);
  update public.payments set amount=p_original_amount,discount_amount=v_discount,final_amount=v_final,
    payment_method=case when v_status='paid' then 'courtesy' else payment_method end,payment_status=v_status,
    paid_at=case when v_status='paid' then coalesce(paid_at,now()) end,updated_at=now() where id=v_payment.id;
  update public.orders set base_amount=p_original_amount,discount_amount=v_discount,final_amount=v_final,status=case when v_status='paid' then 'confirmed' else 'pending' end,
    confirmed_at=case when v_status='paid' then coalesce(confirmed_at,now()) else confirmed_at end where id=v_order.id;
  update public.order_items set unit_price=p_original_amount,discount_amount=v_discount,final_amount=v_final,status=case when v_status='paid' then 'confirmed' else 'reserved' end,
    reservation_expires_at=case when v_status='paid' then null else reservation_expires_at end,updated_at=now() where id=v_item.id;
  if v_status='paid' then perform public.confirm_order_item_and_issue_ticket(v_item.id); end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('coupon_redeemed','payments',v_payment.id,p_event_id,
    jsonb_build_object('coupon_id',v_coupon.id,'coupon_code',v_coupon.code,'participant_projection_id',p_participant_id,'payment_id',v_payment.id,
      'order_id',v_order.id,'order_item_id',v_item.id,'original_amount',p_original_amount,'discount_amount',v_discount,'final_amount',v_final));
  return query select v_discount,v_final,v_status,case when v_status='paid' then 'Cortesia aplicada e pagamento confirmado.' else 'Cupom aplicado com sucesso.' end;
end; $function$;

commit;
