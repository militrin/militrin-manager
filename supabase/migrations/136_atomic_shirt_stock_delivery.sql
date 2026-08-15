-- 136_atomic_shirt_stock_delivery.sql
-- Torna estoque de camiseta uma pre-condicao atomica das entregas ticket-first.

begin;

-- Demanda comprometida pode exceder o estoque fisico recebido. Substitui o
-- CHECK anonimo da 092 por uma garantia exclusivamente fisica.
do $$ declare v_constraint record;
begin
  for v_constraint in
    select conname from pg_constraint
    where conrelid='public.event_kit_item_variant_inventory'::regclass
      and contype='c'
      and regexp_replace(pg_get_constraintdef(oid),'\s+','','g') ilike '%reserved_quantity+delivered_quantity<=total_quantity%'
  loop
    execute format('alter table public.event_kit_item_variant_inventory drop constraint %I',v_constraint.conname);
  end loop;
end $$;

alter table public.event_kit_item_variant_inventory
  drop constraint if exists event_kit_item_variant_inventory_physical_stock_bounds;
alter table public.event_kit_item_variant_inventory
  add constraint event_kit_item_variant_inventory_physical_stock_bounds
  check(delivered_quantity<=total_quantity);

create or replace function public.set_event_kit_item_variant_stock(p_variant_id uuid,p_total_quantity integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_item uuid; v_event uuid; v_org uuid; v_delivered integer;
begin
  if auth.uid() is null or not public.current_user_has_permission('inventory.adjust') then raise exception 'Sem permissao para ajustar estoque.'; end if;
  if p_total_quantity<0 then raise exception 'Quantidade invalida.'; end if;
  select v.kit_item_id,eki.event_id,e.organization_id into v_item,v_event,v_org
  from public.event_kit_item_variants v join public.event_kit_items eki on eki.id=v.kit_item_id
  join public.events e on e.id=eki.event_id where v.id=p_variant_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_org) then raise exception 'Variante invalida ou sem acesso.'; end if;
  select delivered_quantity into v_delivered from public.event_kit_item_variant_inventory
    where kit_item_id=v_item and variant_id=p_variant_id for update;
  if coalesce(v_delivered,0)>p_total_quantity then raise exception 'Estoque fisico nao pode ser menor que a quantidade ja entregue.'; end if;
  insert into public.event_kit_item_variant_inventory(organization_id,event_id,kit_item_id,variant_id,total_quantity)
  values(v_org,v_event,v_item,p_variant_id,p_total_quantity)
  on conflict(kit_item_id,variant_id) do update set total_quantity=excluded.total_quantity,updated_at=now();
  return true;
end; $$;

drop function public.get_admin_ticket_shirt_options(uuid);
create function public.get_admin_ticket_shirt_options(p_ticket_id uuid)
returns table(kit_item_id uuid,variant_id uuid,shirt_type text,shirt_size text,supply_mode text,physical_available integer,option_label text)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ticket public.tickets%rowtype;
begin
  if auth.uid() is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para configurar camiseta.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  return query select eki.id,v.id,v.name,v.value,eki.shirt_supply_mode,
    case when eki.shirt_supply_mode='stock' then greatest(coalesce(inv.total_quantity,0)-coalesce(inv.delivered_quantity,0),0) end,
    case when eki.shirt_supply_mode='made_to_order' then v.name||' / '||v.value||' - Sob encomenda' else v.name||' / '||v.value end
  from public.event_kit_items eki join public.event_kit_item_variants v on v.kit_item_id=eki.id and v.is_active
  left join public.event_kit_item_variant_inventory inv on inv.kit_item_id=eki.id and inv.variant_id=v.id
  where eki.event_id=v_ticket.event_id and eki.item_type='shirt' and eki.is_active
    and eki.shirt_supply_mode in('stock','made_to_order')
    and (eki.shirt_supply_mode='made_to_order' or greatest(coalesce(inv.total_quantity,0)-coalesce(inv.delivered_quantity,0),0)>0)
  order by v.sort_order,v.name,v.value;
end; $$;

create or replace function public.admin_change_ticket_shirt(p_ticket_id uuid,p_new_shirt_type text,p_new_shirt_size text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype; v_link public.participant_kit_items%rowtype; v_old_inv public.event_kit_item_variant_inventory%rowtype;
  v_new_inv public.event_kit_item_variant_inventory%rowtype; v_qty integer; v_old_variant uuid;
begin
  if v_actor is null or not public.current_user_has_permission('inventory.change_participant_shirt') then raise exception 'Sem permissao para trocar camiseta.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor,v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into strict v_oi from public.order_items where id=v_ticket.order_item_id for update;
  -- Apos a 137, esta chamada tambem enriquece vinculos legados de camiseta
  -- sem variant_id antes de ajustar os contadores agregados de reserva.
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'admin_change_ticket_shirt');
  select * into strict v_item from public.event_kit_items where event_id=v_ticket.event_id and item_type='shirt' and is_active;
  if v_item.shirt_supply_mode is null or v_item.shirt_supply_mode='disabled' then raise exception 'Fornecimento de camiseta indisponivel.'; end if;
  select * into strict v_variant from public.event_kit_item_variants where kit_item_id=v_item.id and is_active and name=trim(p_new_shirt_type) and value=trim(p_new_shirt_size);
  select * into v_link from public.participant_kit_items where ticket_id=p_ticket_id and kit_item_id=v_item.id for update;
  if found and v_link.status='delivered' then raise exception 'Camiseta ja entregue; use operacao explicita de troca ou estorno.'; end if;
  v_qty:=greatest(coalesce(v_link.quantity,v_item.quantity_per_participant),1);
  v_old_variant:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  if v_item.shirt_supply_mode='stock' then
    select * into v_new_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_variant.id for update;
    if not found or v_new_inv.total_quantity-v_new_inv.delivered_quantity<v_qty then
      raise exception using errcode='P0001',message='SHIRT_OUT_OF_STOCK',detail=jsonb_build_object(
        'code','SHIRT_OUT_OF_STOCK','shirt_type',v_variant.name,'shirt_size',v_variant.value,
        'physical_available',greatest(coalesce(v_new_inv.total_quantity,0)-coalesce(v_new_inv.delivered_quantity,0),0),
        'message',format('Nao ha estoque disponivel para %s %s. A troca nao foi confirmada.',v_variant.name,v_variant.value))::text;
    end if;
    if v_old_variant is distinct from v_variant.id then
      select * into v_old_inv from public.event_kit_item_variant_inventory where kit_item_id=v_item.id and variant_id=v_old_variant for update;
      if found then update public.event_kit_item_variant_inventory set reserved_quantity=greatest(reserved_quantity-v_qty,0),updated_at=now() where id=v_old_inv.id; end if;
      update public.event_kit_item_variant_inventory set reserved_quantity=reserved_quantity+v_qty,updated_at=now() where id=v_new_inv.id;
    end if;
  end if;
  update public.order_items set shirt_type=v_variant.name,shirt_size=v_variant.value,updated_at=now() where id=v_oi.id;
  insert into public.participant_kit_items(ticket_id,order_item_id,participant_id,event_id,organization_id,kit_item_id,variant_data,quantity,status)
  values(v_ticket.id,v_oi.id,coalesce(v_oi.participant_id,v_ticket.participant_id),v_ticket.event_id,v_ticket.organization_id,v_item.id,
    jsonb_build_object('variant_id',v_variant.id,'shirt_type',v_variant.name,'shirt_size',v_variant.value,'supply_mode',v_item.shirt_supply_mode),v_qty,'confirmed')
  on conflict(ticket_id,kit_item_id) where ticket_id is not null do update set variant_data=excluded.variant_data,quantity=excluded.quantity;
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details) values('ticket_shirt_admin_changed','tickets',v_ticket.id,v_ticket.event_id,
    jsonb_build_object('actor_user_id',v_actor,'kit_item_id',v_item.id,'variant_id',v_variant.id,'supply_mode',v_item.shirt_supply_mode));
  return true;
end; $$;

create or replace function public.raise_shirt_out_of_stock(
  p_shirt_type text,
  p_shirt_size text,
  p_physical_available integer
)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  raise exception using
    errcode='P0001',
    message='SHIRT_OUT_OF_STOCK',
    detail=jsonb_build_object(
      'code','SHIRT_OUT_OF_STOCK',
      'shirt_type',coalesce(p_shirt_type,''),
      'shirt_size',coalesce(p_shirt_size,''),
      'physical_available',greatest(coalesce(p_physical_available,0),0),
      'message',format('Nao ha estoque disponivel para %s %s. A entrega nao foi confirmada.',coalesce(p_shirt_type,'Camiseta'),coalesce(p_shirt_size,''))
    )::text;
end; $$;

create or replace function public.get_ticket_shirt_stock(p_ticket_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ticket public.tickets%rowtype; v_row record; v_available integer;
begin
  if auth.uid() is null or not public.current_user_has_permission('participants.view') then raise exception 'Sem permissao para consultar ingresso.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select pki.status,pki.quantity,eki.shirt_supply_mode,v.name as shirt_type,v.value as shirt_size,
    inv.total_quantity,inv.delivered_quantity
  into v_row
  from public.participant_kit_items pki
  join public.event_kit_items eki on eki.id=pki.kit_item_id and eki.item_type='shirt'
  left join public.event_kit_item_variants v on v.id=nullif(pki.variant_data->>'variant_id','')::uuid
  left join public.event_kit_item_variant_inventory inv on inv.kit_item_id=pki.kit_item_id and inv.variant_id=v.id
  where pki.ticket_id=p_ticket_id order by pki.created_at limit 1;
  if not found then return null; end if;
  v_available:=case when v_row.shirt_supply_mode='stock' then greatest(coalesce(v_row.total_quantity,0)-coalesce(v_row.delivered_quantity,0),0) else null end;
  return jsonb_build_object('shirt_type',coalesce(v_row.shirt_type,''),'shirt_size',coalesce(v_row.shirt_size,''),
    'supply_mode',coalesce(v_row.shirt_supply_mode,''),'physical_available',v_available,
    'status',case when v_row.status='delivered' or v_row.shirt_supply_mode<>'stock' then 'not_applicable'
      when v_available=0 then 'out_of_stock' when v_available=1 then 'last_unit' else 'available' end);
end; $$;

create or replace function public.deliver_ticket_kit_item(p_ticket_id uuid,p_kit_item_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_link public.participant_kit_items%rowtype;
  v_ticket public.tickets%rowtype;
  v_item public.event_kit_items%rowtype;
  v_variant public.event_kit_item_variants%rowtype;
  v_inv public.event_kit_item_variant_inventory%rowtype;
  v_variant_id uuid;
  v_available integer;
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
    select * into strict v_variant from public.event_kit_item_variants where id=v_variant_id and kit_item_id=v_item.id;
    if v_item.shirt_supply_mode='stock' then
      select * into v_inv from public.event_kit_item_variant_inventory
      where kit_item_id=v_item.id and variant_id=v_variant_id for update;
      v_available:=case when found then greatest(v_inv.total_quantity-v_inv.delivered_quantity,0) else 0 end;
      if v_inv.id is null or v_available<v_link.quantity then
        perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,v_available);
      end if;
      update public.event_kit_item_variant_inventory
      set reserved_quantity=greatest(reserved_quantity-v_link.quantity,0),
          delivered_quantity=delivered_quantity+v_link.quantity,updated_at=now()
      where id=v_inv.id
        and total_quantity-delivered_quantity>=v_link.quantity;
      if not found then perform public.raise_shirt_out_of_stock(v_variant.name,v_variant.value,0); end if;
    end if;
  end if;

  update public.participant_kit_items set status='delivered',delivered_at=now() where id=v_link.id and status<>'delivered';
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('ticket_kit_item_delivered','participant_kit_items',v_link.id,v_link.event_id,
    jsonb_build_object('actor_user_id',auth.uid(),'ticket_id',p_ticket_id,'kit_item_id',p_kit_item_id,
      'supply_mode',v_item.shirt_supply_mode,'variant_id',v_variant_id));
  return true;
end; $$;

create or replace function public.deliver_ticket_full_kit(p_ticket_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row record; v_ticket public.tickets%rowtype; v_available integer;
begin
  if auth.uid() is null or not public.current_user_has_permission('kits.deliver') then raise exception 'Sem permissao para entregar kit.'; end if;
  select * into v_ticket from public.tickets where id=p_ticket_id for update;
  if not found or not public.user_can_access_organization(auth.uid(),v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  perform public.materialize_ticket_kit_items_internal(p_ticket_id,'full_delivery');
  if exists(select 1 from public.event_kit_items eki where eki.event_id=v_ticket.event_id and eki.is_active
    and not exists(select 1 from public.participant_kit_items pki where pki.ticket_id=p_ticket_id and pki.kit_item_id=eki.id)) then
    raise exception 'Existem itens aplicaveis com configuracao pendente.';
  end if;

  -- Bloqueia e valida todas as variantes antes de alterar qualquer item.
  for v_row in
    select pki.kit_item_id,pki.quantity,v.id as variant_id,v.name as shirt_type,v.value as shirt_size
    from public.participant_kit_items pki
    join public.event_kit_items eki on eki.id=pki.kit_item_id
    left join public.event_kit_item_variants v on v.id=nullif(pki.variant_data->>'variant_id','')::uuid
    where pki.ticket_id=p_ticket_id and pki.status not in('delivered','cancelled')
      and eki.item_type='shirt' and eki.shirt_supply_mode='stock'
    order by pki.kit_item_id
    for update of pki
  loop
    select greatest(inv.total_quantity-inv.delivered_quantity,0)
      into v_available
    from public.event_kit_item_variant_inventory inv
    where inv.kit_item_id=v_row.kit_item_id and inv.variant_id=v_row.variant_id for update;
    if not found then v_available:=0; end if;
    if v_available<v_row.quantity then
      perform public.raise_shirt_out_of_stock(v_row.shirt_type,v_row.shirt_size,v_available);
    end if;
  end loop;

  for v_row in select kit_item_id from public.participant_kit_items
    where ticket_id=p_ticket_id and status not in('delivered','cancelled') order by kit_item_id
  loop
    perform public.deliver_ticket_kit_item(p_ticket_id,v_row.kit_item_id);
  end loop;
  return true;
end; $$;

-- A funcao combinada permanece uma unica transacao PostgreSQL. Qualquer erro no
-- estoque, na entrega ou no check-in desfaz todas as alteracoes anteriores.
create or replace function public.deliver_items_and_checkin(p_ticket_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_ok boolean;
begin
  if auth.uid() is null then raise exception 'Usuario nao autenticado.'; end if;
  if not public.current_user_has_permission('kits.deliver') or not public.current_user_has_permission('checkin.scan') then raise exception 'Sem permissao para entrega e check-in.'; end if;
  perform 1 from public.tickets where id=p_ticket_id for update;
  if not found then raise exception 'Ingresso nao encontrado.'; end if;
  perform public.deliver_ticket_full_kit(p_ticket_id);
  select public.checkin_ticket_entry(p_ticket_id) into v_ok;
  if v_ok is distinct from true then raise exception 'Nao foi possivel realizar o check-in; a entrega foi revertida.'; end if;
  return true;
end; $$;

revoke all on function public.raise_shirt_out_of_stock(text,text,integer) from public,anon,authenticated;
revoke all on function public.get_ticket_shirt_stock(uuid) from public,anon,authenticated;
revoke all on function public.deliver_ticket_kit_item(uuid,uuid),public.deliver_ticket_full_kit(uuid),public.deliver_items_and_checkin(uuid) from public,anon,authenticated;
grant execute on function public.deliver_ticket_kit_item(uuid,uuid),public.deliver_ticket_full_kit(uuid),public.deliver_items_and_checkin(uuid) to authenticated;
grant execute on function public.get_ticket_shirt_stock(uuid) to authenticated;
grant execute on function public.get_admin_ticket_shirt_options(uuid),public.admin_change_ticket_shirt(uuid,text,text),public.set_event_kit_item_variant_stock(uuid,integer) to authenticated;

-- API participant-first da migration 024, sem consumidores atuais.
revoke all on function public.deliver_kit_and_checkin(uuid) from public,anon,authenticated;

commit;
