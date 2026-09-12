-- Check-in e entrega de kit sao processos independentes.
-- reserved_quantity do kit do ingresso deve permanecer enquanto o ticket for
-- operacional (active ou used), o kit nao tiver sido entregue/cancelado e
-- houver variant_id. A RPC anterior exigia ticket.status='active', entao o
-- trigger trg_reconcile_ticket_shirt_demand_status soltava a reserva no
-- check-in (active -> used) mesmo com o kit ainda pendente.
-- Esta migration so substitui a funcao. Nao faz backfill nem UPDATE de
-- inventory; com zero tickets used o contador atual permanece igual.
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

  perform 1 from public.event_kit_item_variant_inventory as inventory
  where inventory.kit_item_id=p_kit_item_id and inventory.variant_id=p_variant_id
  for update;

  select
    coalesce(sum(source.reserved_quantity),0)::integer,
    coalesce(sum(source.delivered_quantity),0)::integer
  into v_reserved,v_delivered
  from (
    select
      case when ticket.status in('active','used') and kit_link.status not in('delivered','cancelled') then kit_link.quantity else 0 end as reserved_quantity,
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

commit;
