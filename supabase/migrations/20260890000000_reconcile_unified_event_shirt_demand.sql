-- Reserva de camiseta e uma projecao de toda demanda fisica ainda nao entregue.
-- participant_kit_items e store_order_items continuam sendo os vinculos canonicos;
-- o contador agregado nunca e usado como fonte para o proprio backfill.
begin;

create or replace function public.reconcile_event_shirt_variant_inventory(
  p_kit_item_id uuid,
  p_variant_id uuid
) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_reserved integer;
  v_delivered integer;
begin
  if p_kit_item_id is null or p_variant_id is null then return; end if;
  if not exists(
    select 1 from public.event_kit_item_variants as variant
    join public.event_kit_items as kit_item on kit_item.id=variant.kit_item_id
    where variant.id=p_variant_id and variant.kit_item_id=p_kit_item_id and kit_item.item_type='shirt'
  ) then return; end if;

  -- Serializa todas as escritas incrementais e reconciliacoes da variante.
  perform 1 from public.event_kit_item_variant_inventory as inventory
  where inventory.kit_item_id=p_kit_item_id and inventory.variant_id=p_variant_id
  for update;

  select
    coalesce(sum(source.reserved_quantity),0)::integer,
    coalesce(sum(source.delivered_quantity),0)::integer
  into v_reserved,v_delivered
  from (
    select
      case when ticket.status='active' and kit_link.status not in('delivered','cancelled') then kit_link.quantity else 0 end as reserved_quantity,
      case when kit_link.status='delivered' then kit_link.quantity else 0 end as delivered_quantity
    from public.participant_kit_items as kit_link
    join public.tickets as ticket on ticket.id=kit_link.ticket_id
    where kit_link.kit_item_id=p_kit_item_id
      and nullif(kit_link.variant_data->>'variant_id','')::uuid=p_variant_id

    union all

    select
      case when store_order.status not in('cancelled','expired') and store_line.status in('reserved','confirmed') then store_line.quantity else 0 end,
      case when store_line.status='delivered' then store_line.quantity else 0 end
    from public.store_order_items as store_line
    join public.store_orders as store_order on store_order.id=store_line.store_order_id
    join public.store_items as store_item on store_item.id=store_line.store_item_id
    join public.store_item_variants as store_variant on store_variant.id=store_line.variant_id and store_variant.store_item_id=store_item.id
    where store_item.linked_event_kit_item_id=p_kit_item_id
      and store_variant.linked_event_kit_item_variant_id=p_variant_id

    union all

    select
      case when customer_order.status not in('cancelled','expired','refunded') and cart_line.status not in('cancelled','expired','refunded','transferred','delivered') then cart_line.quantity else 0 end,
      case when cart_line.status='delivered' then cart_line.quantity else 0 end
    from public.order_items as cart_line
    join public.orders as customer_order on customer_order.id=cart_line.order_id
    join public.store_items as store_item on store_item.id=cart_line.store_item_id
    join public.store_item_variants as store_variant on store_variant.id=cart_line.store_item_variant_id and store_variant.store_item_id=store_item.id
    where cart_line.item_kind='product'
      and store_item.linked_event_kit_item_id=p_kit_item_id
      and store_variant.linked_event_kit_item_variant_id=p_variant_id
  ) as source;

  update public.event_kit_item_variant_inventory as inventory
  set reserved_quantity=greatest(v_reserved,0),
      delivered_quantity=greatest(v_delivered,0),
      updated_at=now()
  where inventory.kit_item_id=p_kit_item_id and inventory.variant_id=p_variant_id;
end; $$;

revoke all on function public.reconcile_event_shirt_variant_inventory(uuid,uuid) from public,anon,authenticated;
grant execute on function public.reconcile_event_shirt_variant_inventory(uuid,uuid) to service_role;

create or replace function public.trg_reconcile_participant_shirt_demand()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_old_variant_id uuid; v_new_variant_id uuid;
begin
  if tg_op<>'INSERT' then v_old_variant_id:=nullif(old.variant_data->>'variant_id','')::uuid; end if;
  if tg_op<>'DELETE' then v_new_variant_id:=nullif(new.variant_data->>'variant_id','')::uuid; end if;
  if tg_op<>'INSERT' and v_old_variant_id is not null then
    perform public.reconcile_event_shirt_variant_inventory(old.kit_item_id,v_old_variant_id);
  end if;
  if tg_op<>'DELETE' and v_new_variant_id is not null
    and (tg_op='INSERT' or new.kit_item_id is distinct from old.kit_item_id or v_new_variant_id is distinct from v_old_variant_id
      or new.quantity is distinct from old.quantity or new.status is distinct from old.status or new.ticket_id is distinct from old.ticket_id) then
    perform public.reconcile_event_shirt_variant_inventory(new.kit_item_id,v_new_variant_id);
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;

drop trigger if exists trg_reconcile_participant_shirt_demand on public.participant_kit_items;
create trigger trg_reconcile_participant_shirt_demand
after insert or update of kit_item_id,ticket_id,variant_data,quantity,status or delete on public.participant_kit_items
for each row execute function public.trg_reconcile_participant_shirt_demand();

create or replace function public.trg_reconcile_store_shirt_demand()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_old record; v_new record;
begin
  if tg_op<>'INSERT' then
    select item.linked_event_kit_item_id as kit_item_id,variant.linked_event_kit_item_variant_id as variant_id into v_old
    from public.store_items as item left join public.store_item_variants as variant on variant.id=old.variant_id
    where item.id=old.store_item_id;
    if v_old.kit_item_id is not null and v_old.variant_id is not null then
      perform public.reconcile_event_shirt_variant_inventory(v_old.kit_item_id,v_old.variant_id);
    end if;
  end if;
  if tg_op<>'DELETE' then
    select item.linked_event_kit_item_id as kit_item_id,variant.linked_event_kit_item_variant_id as variant_id into v_new
    from public.store_items as item left join public.store_item_variants as variant on variant.id=new.variant_id
    where item.id=new.store_item_id;
    if v_new.kit_item_id is not null and v_new.variant_id is not null then
      perform public.reconcile_event_shirt_variant_inventory(v_new.kit_item_id,v_new.variant_id);
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;

drop trigger if exists trg_reconcile_store_shirt_demand on public.store_order_items;
create trigger trg_reconcile_store_shirt_demand
after insert or update of store_order_id,store_item_id,variant_id,quantity,status or delete on public.store_order_items
for each row execute function public.trg_reconcile_store_shirt_demand();

create or replace function public.trg_reconcile_cart_shirt_demand()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_old record; v_new record;
begin
  if tg_op<>'INSERT' and old.item_kind='product' then
    select item.linked_event_kit_item_id as kit_item_id,variant.linked_event_kit_item_variant_id as variant_id into v_old
    from public.store_items as item left join public.store_item_variants as variant on variant.id=old.store_item_variant_id
    where item.id=old.store_item_id;
    if v_old.kit_item_id is not null and v_old.variant_id is not null then perform public.reconcile_event_shirt_variant_inventory(v_old.kit_item_id,v_old.variant_id); end if;
  end if;
  if tg_op<>'DELETE' and new.item_kind='product' then
    select item.linked_event_kit_item_id as kit_item_id,variant.linked_event_kit_item_variant_id as variant_id into v_new
    from public.store_items as item left join public.store_item_variants as variant on variant.id=new.store_item_variant_id
    where item.id=new.store_item_id;
    if v_new.kit_item_id is not null and v_new.variant_id is not null then perform public.reconcile_event_shirt_variant_inventory(v_new.kit_item_id,v_new.variant_id); end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;

drop trigger if exists trg_reconcile_cart_shirt_demand on public.order_items;
create trigger trg_reconcile_cart_shirt_demand
after insert or update of order_id,item_kind,store_item_id,store_item_variant_id,quantity,status or delete on public.order_items
for each row execute function public.trg_reconcile_cart_shirt_demand();

create or replace function public.trg_reconcile_ticket_shirt_demand_status()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_link record;
begin
  if new.status is not distinct from old.status then return new; end if;
  for v_link in select kit_link.kit_item_id,nullif(kit_link.variant_data->>'variant_id','')::uuid as variant_id
    from public.participant_kit_items as kit_link where kit_link.ticket_id=new.id
  loop perform public.reconcile_event_shirt_variant_inventory(v_link.kit_item_id,v_link.variant_id); end loop;
  return new;
end; $$;

drop trigger if exists trg_reconcile_ticket_shirt_demand_status on public.tickets;
create trigger trg_reconcile_ticket_shirt_demand_status after update of status on public.tickets
for each row execute function public.trg_reconcile_ticket_shirt_demand_status();

create or replace function public.trg_reconcile_store_order_shirt_demand_status()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_link record;
begin
  if new.status is not distinct from old.status then return new; end if;
  for v_link in
    select distinct item.linked_event_kit_item_id as kit_item_id,variant.linked_event_kit_item_variant_id as variant_id
    from public.store_order_items as line
    join public.store_items as item on item.id=line.store_item_id
    join public.store_item_variants as variant on variant.id=line.variant_id
    where line.store_order_id=new.id and item.linked_event_kit_item_id is not null and variant.linked_event_kit_item_variant_id is not null
  loop perform public.reconcile_event_shirt_variant_inventory(v_link.kit_item_id,v_link.variant_id); end loop;
  return new;
end; $$;

drop trigger if exists trg_reconcile_store_order_shirt_demand_status on public.store_orders;
create trigger trg_reconcile_store_order_shirt_demand_status after update of status on public.store_orders
for each row execute function public.trg_reconcile_store_order_shirt_demand_status();

create or replace function public.trg_reconcile_customer_order_shirt_demand_status()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_link record;
begin
  if new.status is not distinct from old.status then return new; end if;
  for v_link in
    select distinct item.linked_event_kit_item_id as kit_item_id,variant.linked_event_kit_item_variant_id as variant_id
    from public.order_items as line
    join public.store_items as item on item.id=line.store_item_id
    join public.store_item_variants as variant on variant.id=line.store_item_variant_id
    where line.order_id=new.id and line.item_kind='product' and item.linked_event_kit_item_id is not null and variant.linked_event_kit_item_variant_id is not null
  loop perform public.reconcile_event_shirt_variant_inventory(v_link.kit_item_id,v_link.variant_id); end loop;
  return new;
end; $$;

drop trigger if exists trg_reconcile_customer_order_shirt_demand_status on public.orders;
create trigger trg_reconcile_customer_order_shirt_demand_status after update of status on public.orders
for each row execute function public.trg_reconcile_customer_order_shirt_demand_status();

create or replace function public.trg_reconcile_linked_store_variant_demand()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_kit_item_id uuid;
begin
  select item.linked_event_kit_item_id into v_kit_item_id from public.store_items as item where item.id=new.store_item_id;
  if v_kit_item_id is null then return new; end if;
  if old.linked_event_kit_item_variant_id is not null then
    perform public.reconcile_event_shirt_variant_inventory(v_kit_item_id,old.linked_event_kit_item_variant_id);
  end if;
  if new.linked_event_kit_item_variant_id is not null and new.linked_event_kit_item_variant_id is distinct from old.linked_event_kit_item_variant_id then
    perform public.reconcile_event_shirt_variant_inventory(v_kit_item_id,new.linked_event_kit_item_variant_id);
  end if;
  return new;
end; $$;

drop trigger if exists trg_reconcile_linked_store_variant_demand on public.store_item_variants;
create trigger trg_reconcile_linked_store_variant_demand after update of linked_event_kit_item_variant_id on public.store_item_variants
for each row execute function public.trg_reconcile_linked_store_variant_demand();

-- Mantem a API introduzida na migration 80, mas troca soma incremental por
-- reconciliacao deterministica das duas origens para impedir dupla contagem.
create or replace function public.account_ticket_shirt_demand(p_link_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_link public.participant_kit_items%rowtype; v_variant_id uuid;
begin
  select * into v_link from public.participant_kit_items where id=p_link_id for update;
  if not found or v_link.status in('delivered','cancelled') then return; end if;
  v_variant_id:=nullif(v_link.variant_data->>'variant_id','')::uuid;
  if v_variant_id is null then return; end if;
  update public.participant_kit_items as target set inventory_reservation_accounted=true where target.id=v_link.id and not target.inventory_reservation_accounted;
  perform public.reconcile_event_shirt_variant_inventory(v_link.kit_item_id,v_variant_id);
end; $$;

revoke all on function public.account_ticket_shirt_demand(uuid) from public,anon,authenticated;
grant execute on function public.account_ticket_shirt_demand(uuid) to service_role;

-- O carrinho unificado ainda consultava store_item_inventory diretamente.
-- Para produto vinculado isso e um segundo estoque incorreto; delega ao mesmo
-- roteador canonico ja usado por compra e concessao em store_orders.
create or replace function public.add_product_to_cart_order(p_order_id uuid,p_store_item_id uuid,p_variant_id uuid default null,p_quantity integer default 1)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_order public.orders%rowtype; v_store_item public.store_items%rowtype;
  v_variant public.store_item_variants%rowtype; v_unit_price numeric; v_existing public.order_items%rowtype;
  v_item_id uuid; v_new_quantity integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if coalesce(p_quantity,0)<=0 then raise exception 'Quantidade invalida.'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id=v_actor or public.user_can_access_organization(v_actor,v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status<>'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;
  select * into v_store_item from public.store_items where id=p_store_item_id
    and (event_id=v_order.event_id or event_id is null) and is_active and organization_id=v_order.organization_id;
  if not found then raise exception 'Produto indisponivel para este pedido.'; end if;
  if v_store_item.requires_variant and p_variant_id is null then raise exception 'Produto exige selecao de variante.'; end if;
  v_unit_price:=v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants where id=p_variant_id and store_item_id=v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o produto.'; end if;
    v_unit_price:=v_unit_price+coalesce(v_variant.price_adjustment,0);
  end if;
  select * into v_existing from public.order_items where order_id=p_order_id and item_kind='product'
    and store_item_id=v_store_item.id and store_item_variant_id is not distinct from p_variant_id
    and status not in('cancelled','expired','refunded','transferred') for update;
  perform public.reserve_store_item_stock(v_store_item.id,p_variant_id,p_quantity);
  if found and v_existing.id is not null then
    v_new_quantity:=v_existing.quantity+p_quantity;
    update public.order_items set quantity=v_new_quantity,unit_price=v_unit_price,final_amount=round(v_unit_price*v_new_quantity,2),updated_at=now()
    where id=v_existing.id returning id into v_item_id;
  else
    insert into public.order_items(order_id,event_id,item_kind,store_item_id,store_item_variant_id,quantity,unit_price,discount_amount,final_amount,status,ownership_status)
    values(p_order_id,v_order.event_id,'product',v_store_item.id,p_variant_id,p_quantity,v_unit_price,0,round(v_unit_price*p_quantity,2),'reserved','unassigned')
    returning id into v_item_id;
  end if;
  perform public.apply_cart_coupon(p_order_id,(select coupon.code from public.coupons as coupon where coupon.id=v_order.applied_coupon_id));
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('cart_product_added','orders',p_order_id,v_order.event_id,jsonb_build_object('actor_user_id',v_actor,'store_item_id',v_store_item.id,'variant_id',p_variant_id,'quantity_added',p_quantity,'order_item_id',v_item_id));
  return jsonb_build_object('order_item_ids',array[v_item_id],'unit_price',v_unit_price);
end; $$;

create or replace function public.set_cart_order_item_quantity(p_order_item_id uuid,p_quantity integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid:=auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype; v_unit_price numeric; v_delta integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if coalesce(p_quantity,0)<=0 then raise exception 'Quantidade invalida.'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if not found then raise exception 'Item nao encontrado.'; end if;
  if v_item.item_kind<>'product' then raise exception 'Somente itens de produto tem quantidade ajustavel por aqui.'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if not (v_order.user_id=v_actor or public.user_can_access_organization(v_actor,v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status<>'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;
  if v_item.status='cancelled' then raise exception 'Item ja foi removido do carrinho.'; end if;
  select * into v_store_item from public.store_items where id=v_item.store_item_id;
  if not found then raise exception 'Produto do item nao encontrado.'; end if;
  v_unit_price:=v_store_item.price;
  if v_item.store_item_variant_id is not null then
    select * into v_variant from public.store_item_variants where id=v_item.store_item_variant_id;
    if found then v_unit_price:=v_unit_price+coalesce(v_variant.price_adjustment,0); end if;
  end if;
  v_delta:=p_quantity-v_item.quantity;
  if v_delta>0 then perform public.reserve_store_item_stock(v_item.store_item_id,v_item.store_item_variant_id,v_delta);
  elsif v_delta<0 then perform public.release_store_item_reservation(v_item.store_item_id,v_item.store_item_variant_id,-v_delta); end if;
  update public.order_items set quantity=p_quantity,unit_price=v_unit_price,final_amount=round(v_unit_price*p_quantity,2),updated_at=now() where id=p_order_item_id;
  perform public.apply_cart_coupon(v_order.id,(select coupon.code from public.coupons as coupon where coupon.id=v_order.applied_coupon_id));
  insert into public.audit_logs(action,entity_type,entity_id,event_id,details)
  values('cart_product_quantity_changed','orders',v_order.id,v_order.event_id,jsonb_build_object('actor_user_id',v_actor,'order_item_id',p_order_item_id,'quantity',p_quantity,'previous_quantity',v_item.quantity));
  return jsonb_build_object('order_id',v_order.id,'order_item_id',p_order_item_id,'quantity',p_quantity);
end; $$;

-- Backfill global, deterministico e idempotente. Cada execucao substitui a
-- projecao agregada pelo estado atual das duas fontes canonicas.
do $$ declare v_variant record;
begin
  for v_variant in
    select variant.kit_item_id,variant.id as variant_id
    from public.event_kit_item_variants as variant
    join public.event_kit_items as kit_item on kit_item.id=variant.kit_item_id
    where kit_item.item_type='shirt'
    order by variant.kit_item_id,variant.id
  loop
    perform public.reconcile_event_shirt_variant_inventory(v_variant.kit_item_id,v_variant.variant_id);
  end loop;
end $$;

commit;
