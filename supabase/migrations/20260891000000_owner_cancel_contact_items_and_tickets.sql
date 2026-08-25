begin;

-- Cancelamento administrativo restrito ao Owner. A reserva de camiseta do
-- ingresso nao e decrementada: status canonicos mudam e os triggers da
-- migration 90 recalculam a projecao da variante na mesma transacao.
create or replace function public.owner_cancel_ticket(p_ticket_id uuid,p_reason_code text,p_reason_text text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_link record;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_ticket from public.tickets as ticket where ticket.id=p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  if not public.is_organization_owner(v_actor,v_ticket.organization_id) then raise exception 'Somente o Owner da organizacao pode excluir ingressos.'; end if;
  if nullif(trim(coalesce(p_reason_code,'')),'') is null then raise exception 'Motivo obrigatorio.'; end if;
  if p_reason_code='other' and nullif(trim(coalesce(p_reason_text,'')),'') is null then raise exception 'Descreva o motivo da exclusao.'; end if;
  if v_ticket.status='cancelled' then return jsonb_build_object('success',true,'changed',false,'ticket_id',v_ticket.id); end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Este ingresso possui check-in realizado. Desfaca o check-in antes de exclui-lo.'; end if;
  if exists(select 1 from public.participant_kit_items as kit_link where kit_link.ticket_id=v_ticket.id and kit_link.status='delivered') then
    raise exception 'Este ingresso possui itens entregues. Desfaca a entrega antes de exclui-lo.';
  end if;

  for v_link in
    select kit_link.id from public.participant_kit_items as kit_link
    where kit_link.ticket_id=v_ticket.id and kit_link.status<>'cancelled' order by kit_link.id for update
  loop
    update public.participant_kit_items as kit_link set status='cancelled' where kit_link.id=v_link.id;
  end loop;
  update public.tickets as ticket set status='cancelled',cancelled_at=coalesce(ticket.cancelled_at,now()) where ticket.id=v_ticket.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('admin_ticket_cancelled','tickets',v_ticket.id,v_ticket.event_id,jsonb_build_object('actor_user_id',v_actor,'reason_code',p_reason_code,'reason_text',nullif(trim(coalesce(p_reason_text,'')),''),'cancelled_at',now()));
  return jsonb_build_object('success',true,'changed',true,'ticket_id',v_ticket.id,'status','cancelled');
end; $$;

revoke all on function public.owner_cancel_ticket(uuid,text,text) from public,anon;
grant execute on function public.owner_cancel_ticket(uuid,text,text) to authenticated,service_role;

-- Fecha o caminho legado: qualquer consumidor antigo continua funcional,
-- mas passa pela mesma verificacao Owner-only e pela mesma reconciliacao.
create or replace function public.admin_cancel_ticket(p_ticket_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  return public.owner_cancel_ticket(p_ticket_id,'administrative_correction',p_reason);
end; $$;

revoke all on function public.admin_cancel_ticket(uuid,text) from public,anon;
grant execute on function public.admin_cancel_ticket(uuid,text) to authenticated,service_role;

-- Itens adicionais preservam pedido e linha. Estoque compartilhado e
-- reconciliado pelo trigger canonico; estoque proprio usa o roteador ja
-- existente. Cobranca paga exige tratamento financeiro explicito.
create or replace function public.owner_cancel_store_order_item(p_store_order_item_id uuid,p_reason_code text,p_reason_text text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype; v_item public.store_items%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_line from public.store_order_items as line where line.id=p_store_order_item_id for update;
  if not found then raise exception 'Item adicional nao encontrado.'; end if;
  select * into strict v_order from public.store_orders as store_order where store_order.id=v_line.store_order_id for update;
  if not public.is_organization_owner(v_actor,v_order.organization_id) then raise exception 'Somente o Owner da organizacao pode excluir itens adicionais.'; end if;
  if nullif(trim(coalesce(p_reason_code,'')),'') is null then raise exception 'Motivo obrigatorio.'; end if;
  if p_reason_code='other' and nullif(trim(coalesce(p_reason_text,'')),'') is null then raise exception 'Descreva o motivo da exclusao.'; end if;
  if v_line.status='cancelled' then return jsonb_build_object('success',true,'changed',false,'item_id',v_line.id); end if;
  if v_line.status='delivered' or v_line.delivered_at is not null then raise exception 'Este item ja foi entregue. Desfaca a entrega antes de exclui-lo.'; end if;
  if v_order.payment_status='paid' and v_order.payment_method<>'admin_courtesy' then raise exception 'Este item possui cobranca paga. Trate o financeiro antes de exclui-lo.'; end if;
  select * into strict v_item from public.store_items as item where item.id=v_line.store_item_id;

  -- Produto nao vinculado conserva o roteador incremental proprio. Para o
  -- vinculado, a mudanca de status abaixo dispara reconciliacao deterministica.
  if v_item.linked_event_kit_item_id is null then
    perform public.release_store_item_reservation(v_line.store_item_id,v_line.variant_id,v_line.quantity);
  end if;
  update public.store_order_items as line set status='cancelled' where line.id=v_line.id;
  if not exists(select 1 from public.store_order_items as sibling where sibling.store_order_id=v_order.id and sibling.status<>'cancelled') then
    update public.store_orders as store_order set status='cancelled',cancelled_at=coalesce(store_order.cancelled_at,now()),updated_at=now() where store_order.id=v_order.id;
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('store_order_item_admin_cancelled','store_order_items',v_line.id,v_order.event_id,jsonb_build_object('actor_user_id',v_actor,'reason_code',p_reason_code,'reason_text',nullif(trim(coalesce(p_reason_text,'')),''),'store_order_id',v_order.id,'store_item_id',v_line.store_item_id,'variant_id',v_line.variant_id,'quantity',v_line.quantity,'cancelled_at',now()));
  return jsonb_build_object('success',true,'changed',true,'item_id',v_line.id,'status','cancelled');
end; $$;

revoke all on function public.owner_cancel_store_order_item(uuid,text,text) from public,anon;
grant execute on function public.owner_cancel_store_order_item(uuid,text,text) to authenticated,service_role;

commit;
