-- 105_canonical_admin_ticket_transfer_and_cancellation.sql
begin;

create or replace function public.search_admin_ticket_holder_candidates(p_ticket_id uuid,p_term text)
returns table(participant_id uuid,full_name text,masked_email text,masked_cpf text,pin_match boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_term text:=trim(coalesce(p_term,'')); v_digits text;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao para buscar titulares.'; end if;
  if length(v_term)<3 then raise exception 'Informe ao menos 3 caracteres para buscar.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  v_digits:=regexp_replace(v_term,'\D','','g');
  return query select p.id,p.full_name,
    case when position('@' in coalesce(p.email,''))>1 then left(p.email,2)||'***@'||split_part(p.email,'@',2) end,
    case when length(regexp_replace(coalesce(p.cpf,''),'\D','','g'))=11 then '***.***.***-'||right(regexp_replace(p.cpf,'\D','','g'),2) end,
    upper(coalesce(cp.public_pin,''))=upper(regexp_replace(v_term,'[^A-Za-z0-9]','','g'))
  from public.participants p left join public.customer_profiles cp on cp.user_id=p.user_id
  where p.organization_id=v_ticket.organization_id and p.event_id=v_ticket.event_id
    and (p.full_name ilike '%'||v_term||'%' or p.email ilike '%'||v_term||'%'
      or (length(v_digits)>=3 and regexp_replace(coalesce(p.cpf,''),'\D','','g') like '%'||v_digits||'%')
      or upper(coalesce(cp.public_pin,''))=upper(regexp_replace(v_term,'[^A-Za-z0-9]','','g')))
  order by p.full_name,p.id limit 20;
end; $$;

create or replace function public.admin_transfer_ticket_holder(p_ticket_id uuid,p_target_participant_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_order public.orders%rowtype; v_target public.participants%rowtype; v_previous uuid;
begin
  if v_actor is null or not public.current_user_has_permission('participants.edit_basic') then raise exception 'Sem permissao para transferir ingresso.'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Motivo obrigatorio.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado nao pode ser transferido.'; end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Ingresso ja utilizado nao pode ser transferido.'; end if;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  select * into strict v_order from public.orders where id=v_ticket.order_id for update;
  if v_item.order_id is distinct from v_ticket.order_id or v_item.event_id is distinct from v_ticket.event_id
    or v_order.event_id is distinct from v_ticket.event_id or v_order.organization_id is distinct from v_ticket.organization_id then
    raise exception 'Cadeia comercial inconsistente para o ingresso.';
  end if;
  select * into v_target from public.participants where id=p_target_participant_id for update;
  if not found or v_target.organization_id is distinct from v_ticket.organization_id or v_target.event_id is distinct from v_ticket.event_id then raise exception 'Novo titular nao pertence ao mesmo evento e organizacao.'; end if;
  v_previous:=v_ticket.participant_id;
  if v_previous=p_target_participant_id then return jsonb_build_object('success',true,'ticket_id',v_ticket.id,'participant_id',v_previous,'changed',false); end if;
  if exists(select 1 from public.tickets t where t.id<>v_ticket.id and t.participant_id=p_target_participant_id and t.event_id=v_ticket.event_id and t.status<>'cancelled') then raise exception 'Novo titular ja possui ingresso ativo neste evento.'; end if;
  if exists(select 1 from public.participant_kit_items pki where pki.ticket_id=v_ticket.id and pki.order_item_id is distinct from v_item.id) then
    raise exception 'Vinculo estrutural ambiguo entre ingresso e itens do kit.';
  end if;
  update public.order_items set participant_id=p_target_participant_id,holder_full_name=v_target.full_name,ownership_status='transferred',updated_at=now() where id=v_item.id;
  update public.tickets set participant_id=p_target_participant_id where id=v_ticket.id;
  update public.participant_kit_items set participant_id=p_target_participant_id,order_item_id=v_item.id where ticket_id=v_ticket.id;
  insert into public.ticket_holder_history(ticket_id,order_item_id,event_id,organization_id,operation,previous_participant_id,new_participant_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason)
  select v_ticket.id,v_item.id,v_ticket.event_id,v_ticket.organization_id,'ticket_transferred',v_previous,v_target.id,oldp.user_id,v_target.user_id,v_actor,'admin',trim(p_reason)
  from public.participants oldp where oldp.id=v_previous;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('admin_ticket_holder_transferred','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('previous_participant_id',v_previous,'new_participant_id',v_target.id,'actor_user_id',v_actor,'reason',trim(p_reason)));
  return jsonb_build_object('success',true,'ticket_id',v_ticket.id,'participant_id',v_target.id,'changed',true);
end; $$;

-- Preserva o contrato de entrega da 104 e fecha explicitamente o ingresso cancelado.
do $delivery_guard$
declare v_signature regprocedure:=to_regprocedure('public.deliver_ticket_kit_item(uuid,uuid)'); v_definition text; v_normalized text;
begin
  if v_signature is null then raise exception 'Funcao canonica de entrega nao encontrada.'; end if;
  select pg_get_functiondef(v_signature) into v_definition;
  v_normalized:=regexp_replace(lower(v_definition),'\s+','','g');
  if position('ingressocanceladonaopermiteentregadekit' in regexp_replace(lower(v_definition),'[^a-z0-9]+','','g'))=0
    and not (
      position('current_user_has_permission(''kits.deliver'')' in v_normalized)>0
      and position('v_item.shirt_supply_mode=''stock''' in v_normalized)>0
      and position('reserved_quantity=reserved_quantity-v_link.quantity' in v_normalized)>0
      and position('ticket_kit_item_delivered' in v_normalized)>0
    ) then
    raise exception 'Definicao ativa de entrega diverge do contrato esperado da migration 104.';
  end if;
end;
$delivery_guard$;

create or replace function public.deliver_ticket_kit_item(p_ticket_id uuid,p_kit_item_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_link public.participant_kit_items%rowtype; v_ticket public.tickets%rowtype; v_item public.event_kit_items%rowtype;
  v_variant_id uuid; v_inv public.event_kit_item_variant_inventory%rowtype;
begin
  if auth.uid() is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para entregar kit.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then raise exception 'Ingresso cancelado nao permite entrega de kit.'; end if;
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id for update;
  if not found then raise exception 'Item do ingresso nao encontrado.'; end if;
  if v_link.status='delivered' then return true; end if;
  if v_link.status='cancelled' then raise exception 'Item cancelado nao pode ser entregue.'; end if;
  if not exists(select 1 from public.payments where order_id=v_ticket.order_id and payment_status='paid') then raise exception 'Pagamento pendente. Entrega bloqueada.'; end if;
  select * into strict v_item from public.event_kit_items where id=p_kit_item_id and event_id=v_ticket.event_id and is_active;
  if v_item.item_type='shirt' then
    if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Camiseta indisponivel para entrega.'; end if;
    v_variant_id:=nullif(v_link.variant_data->>'variant_id','')::uuid;
    if v_variant_id is null then raise exception 'Camiseta nao vinculada.'; end if;
    if v_item.shirt_supply_mode='stock' then
      select * into v_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant_id for update;
      if not found or v_inv.reserved_quantity<v_link.quantity then raise exception 'Reserva de camiseta insuficiente para entrega.'; end if;
      update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity-v_link.quantity,
        delivered_quantity=delivered_quantity+v_link.quantity,updated_at=now() where id=v_inv.id;
    end if;
  end if;
  update public.participant_kit_items set status='delivered',delivered_at=now() where id=v_link.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_kit_item_delivered','participant_kit_items',v_link.id,v_link.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'kit_item_id',p_kit_item_id,'supply_mode',v_item.shirt_supply_mode));
  return true;
end; $$;

create or replace function public.admin_cancel_ticket(p_ticket_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_item public.order_items%rowtype; v_order public.orders%rowtype; v_link record; v_variant uuid; v_inventory public.event_kit_item_variant_inventory%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('orders.cancel') then raise exception 'Sem permissao para cancelar ingresso.'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Motivo obrigatorio.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  if v_ticket.status='cancelled' then return jsonb_build_object('success',true,'ticket_id',v_ticket.id,'status','cancelled','changed',false); end if;
  if v_ticket.status='used' or v_ticket.used_at is not null then raise exception 'Ingresso com check-in; desfaça o check-in antes do cancelamento.'; end if;
  select * into strict v_order from public.orders where id=v_ticket.order_id for update;
  select * into strict v_item from public.order_items where id=v_ticket.order_item_id for update;
  if v_item.order_id is distinct from v_ticket.order_id or v_item.event_id is distinct from v_ticket.event_id
    or v_order.event_id is distinct from v_ticket.event_id or v_order.organization_id is distinct from v_ticket.organization_id then
    raise exception 'Cadeia comercial inconsistente para o ingresso.';
  end if;
  if exists(select 1 from public.participant_kit_items where ticket_id=v_ticket.id and status='delivered') then raise exception 'Ingresso possui item entregue; desfaça a entrega antes do cancelamento.'; end if;
  for v_link in select pki.*,eki.item_type,eki.track_variant_inventory,eki.shirt_supply_mode from public.participant_kit_items pki join public.event_kit_items eki on eki.id=pki.kit_item_id where pki.ticket_id=v_ticket.id and pki.status<>'cancelled' order by pki.id for update of pki loop
    v_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;
    if v_variant is not null and (v_link.track_variant_inventory or (v_link.item_type='shirt' and v_link.shirt_supply_mode='stock')) then
      select * into v_inventory from public.event_kit_item_variant_inventory where kit_item_id=v_link.kit_item_id and variant_id=v_variant for update;
      if not found or v_inventory.reserved_quantity<v_link.quantity then raise exception 'Reserva inconsistente para o item %.',v_link.kit_item_id; end if;
      update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity-v_link.quantity,updated_at=now() where id=v_inventory.id;
    end if;
    update public.participant_kit_items set status='cancelled' where id=v_link.id;
  end loop;
  update public.tickets set status='cancelled',cancelled_at=coalesce(cancelled_at,now()) where id=v_ticket.id;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('admin_ticket_cancelled','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',v_actor,'reason',trim(p_reason)));
  return jsonb_build_object('success',true,'ticket_id',v_ticket.id,'status','cancelled','changed',true);
end; $$;

revoke all on function public.search_admin_ticket_holder_candidates(uuid,text),public.admin_transfer_ticket_holder(uuid,uuid,text),public.admin_cancel_ticket(uuid,text),public.deliver_ticket_kit_item(uuid,uuid) from public,anon,authenticated;
grant execute on function public.search_admin_ticket_holder_candidates(uuid,text),public.admin_transfer_ticket_holder(uuid,uuid,text),public.admin_cancel_ticket(uuid,text),public.deliver_ticket_kit_item(uuid,uuid) to authenticated;
commit;
