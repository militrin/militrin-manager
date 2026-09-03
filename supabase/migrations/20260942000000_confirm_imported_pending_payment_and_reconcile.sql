-- Fecha o fluxo administrativo de pagamentos importados originalmente como
-- pending. A confirmacao e a emissao permanecem atomicas, idempotentes e
-- limitadas aos order_items de ingresso; produtos nunca entram no loop.
begin;

-- Um pagamento ja confirmado e' autorizacao suficiente para reconciliacoes
-- futuras (por exemplo, quando o titular corrige uma pendencia depois). O modo
-- original do lote descreve a decisao da importacao, nao o estado atual.
create or replace function public.finalize_imported_ticket_after_issue_resolution(
  p_order_item_id uuid,p_resolved_fields text[] default array[]::text[],p_force_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_payment public.payments%rowtype; v_batch public.import_batches%rowtype; v_ticket_id uuid; v_blocked boolean; v_finalization text;
  v_can_confirm boolean;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Ingresso comercial nao encontrado.'; end if;
  if v_item.item_kind <> 'ticket' then
    return jsonb_build_object('success',true,'applicable',false,'finalization','not_ticket');
  end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if v_order.buyer_type<>'imported_holder' or v_order.import_batch_id is null then
    return jsonb_build_object('success',true,'applicable',false,'finalization','not_imported');
  end if;
  if not public.user_can_access_organization(v_actor,v_order.organization_id) and not exists(
    select 1 from public.participants p where p.id=v_item.participant_id and p.user_id=v_actor
  ) then raise exception 'Usuario sem acesso ao ingresso.'; end if;
  select * into v_batch from public.import_batches where id=v_order.import_batch_id for update;
  select * into v_payment from public.payments where id=v_order.payment_id for update;
  if not found then raise exception 'Pagamento importado nao encontrado.'; end if;
  select exists(select 1 from public.participant_data_issues i where i.order_item_id=v_item.id and i.status='open' and i.blocks_ticket_issuance) into v_blocked;
  if v_blocked then
    v_finalization:='issues_remaining';
  elsif v_payment.payment_status <> 'paid'
    and coalesce(v_batch.payment_mode_original,'pending')='pending'
    and not p_force_confirm then
    v_finalization:='payment_pending';
  else
    v_can_confirm := v_payment.payment_status='paid'
      or coalesce(v_batch.payment_mode_original,'pending')='confirm_all'
      or public.is_active_owner(v_actor)
      or public.resolve_user_permission(v_actor,'finance.confirm_payment');
    if not v_can_confirm then raise exception 'Sem permissao para confirmar o pagamento.'; end if;
    update public.payments set payment_status='paid',paid_at=coalesce(paid_at,now()),updated_at=now() where id=v_payment.id;
    update public.orders set status='confirmed',confirmed_at=coalesce(confirmed_at,now()) where id=v_order.id;
    update public.order_items set status='confirmed',reservation_expires_at=null,updated_at=now() where id=v_item.id;
    select id into v_ticket_id from public.tickets where order_item_id=v_item.id;
    if v_ticket_id is null then select public.confirm_order_item_and_issue_ticket(v_item.id) into v_ticket_id; end if;
    update public.import_batch_rows set ticket_id=v_ticket_id where order_item_id=v_item.id;
    update public.participant_data_issues set ticket_id=v_ticket_id where order_item_id=v_item.id;
    v_finalization:='paid_and_ticket_issued';
  end if;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('imported_ticket_issue_finalized','order_items',v_item.id,v_item.event_id,jsonb_build_object(
    'order_item_id',v_item.id,'ticket_id',v_ticket_id,'registration_contact_id',v_item.registration_contact_id,
    'import_batch_id',v_batch.id,'fields_resolved',coalesce(p_resolved_fields,array[]::text[]),'actor_user_id',v_actor,'finalization',v_finalization));
  return jsonb_build_object('success',true,'applicable',true,'finalization',v_finalization,'payment_id',v_order.payment_id,
    'order_id',v_order.id,'order_item_id',v_item.id,'ticket_id',v_ticket_id);
end; $$;

create or replace function public.confirm_imported_pending_payment_and_reconcile(
  p_payment_id uuid,
  p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_payment public.payments%rowtype;
  v_order public.orders%rowtype;
  v_item record;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_attempted integer := 0;
  v_issued integer := 0;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if not (public.is_active_owner(v_actor) or public.resolve_user_permission(v_actor,'finance.confirm_payment')) then
    raise exception 'Sem permissao para confirmar pagamentos.';
  end if;
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Motivo obrigatorio (minimo 3 caracteres).'; end if;

  select * into v_payment from public.payments where id=p_payment_id for update;
  if not found then raise exception 'Pagamento nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor,v_payment.organization_id) then raise exception 'Sem acesso a organizacao do pagamento.'; end if;
  select * into v_order from public.orders
  where id=coalesce(v_payment.order_id,(select o.id from public.orders o where o.payment_id=v_payment.id limit 1)) for update;
  if not found or v_order.buyer_type<>'imported_holder' or v_order.import_batch_id is null then
    raise exception 'Pagamento nao pertence a um pedido importado.';
  end if;
  if v_payment.payment_status not in ('pending','paid') then
    raise exception 'Pagamento importado nao pode ser confirmado a partir do status %.',v_payment.payment_status;
  end if;

  if exists(
    select 1 from public.order_items oi join public.participant_data_issues i on i.order_item_id=oi.id
    where oi.order_id=v_order.id and oi.item_kind='ticket' and i.status='open'
      and (i.blocks_payment or i.blocks_ticket_issuance)
  ) then
    return jsonb_build_object('success',false,'reason_code','issues_remaining',
      'message','Existem dados bloqueantes neste pagamento. Resolva as pendencias antes de confirmar.');
  end if;

  for v_item in
    select oi.id from public.order_items oi
    where oi.order_id=v_order.id and oi.item_kind='ticket'
      and oi.status not in ('cancelled','expired','refunded','transferred')
    order by oi.created_at,oi.id
  loop
    v_attempted := v_attempted + 1;
    v_result := public.finalize_imported_ticket_after_issue_resolution(v_item.id,array['payment_confirmation']::text[],true);
    v_results := v_results || jsonb_build_array(v_result);
    if v_result->>'ticket_id' is not null then v_issued := v_issued + 1; end if;
  end loop;
  if v_attempted=0 then raise exception 'Pedido importado sem itens de ingresso elegiveis.'; end if;

  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('imported_payment_confirmed','payments',v_payment.id,v_order.event_id,jsonb_build_object(
    'actor_user_id',v_actor,'organization_id',v_order.organization_id,'order_id',v_order.id,
    'import_batch_id',v_order.import_batch_id,'previous_status',v_payment.payment_status,
    'new_status','paid','reason',trim(p_reason),'ticket_items_attempted',v_attempted,'tickets_available',v_issued));

  return jsonb_build_object('success',true,'payment_id',v_payment.id,'order_id',v_order.id,
    'attempted',v_attempted,'tickets_available',v_issued,'results',v_results,
    'message',case when v_issued>0 then 'Pagamento confirmado e ingressos disponibilizados.' else 'Pagamento ja confirmado; nenhuma emissao pendente.' end);
end; $$;

revoke all on function public.confirm_imported_pending_payment_and_reconcile(uuid,text) from public,anon;
grant execute on function public.confirm_imported_pending_payment_and_reconcile(uuid,text) to authenticated,service_role;

commit;
