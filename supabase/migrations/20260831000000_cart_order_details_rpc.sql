-- Visao do carrinho para a nova etapa "Carrinho": ingressos + produtos no
-- MESMO pedido, cada linha com seus proprios campos (nunca reaproveita
-- get_order_checkout_snapshot, que e especifica de ingresso e permanece
-- intocada -- ver migration anterior).
begin;

create or replace function public.get_cart_order_details(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_items jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', oi.id, 'item_kind', oi.item_kind, 'status', oi.status,
    'unit_price', oi.unit_price, 'discount_amount', oi.discount_amount, 'final_amount', oi.final_amount,
    'ticket_category_id', oi.ticket_category_id, 'category_name', tc.name,
    'shirt_type', oi.shirt_type, 'shirt_size', oi.shirt_size, 'holder_full_name', oi.holder_full_name,
    'store_item_id', oi.store_item_id, 'store_item_name', si.name, 'store_item_image_url', si.image_url,
    'store_item_variant_id', oi.store_item_variant_id, 'variant_name', siv.name, 'variant_value', siv.value
  ) order by oi.item_kind, oi.item_position nulls last, oi.created_at), '[]'::jsonb)
  into v_items
  from public.order_items oi
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.store_items si on si.id = oi.store_item_id
  left join public.store_item_variants siv on siv.id = oi.store_item_variant_id
  where oi.order_id = p_order_id and oi.status not in ('cancelled','expired','refunded','transferred');

  return jsonb_build_object(
    'order_id', v_order.id, 'event_id', v_order.event_id, 'status', v_order.status,
    'base_amount', v_order.base_amount, 'discount_amount', v_order.discount_amount, 'final_amount', v_order.final_amount,
    'applied_coupon_id', v_order.applied_coupon_id,
    'applied_coupon_code', (select code from public.coupons where id = v_order.applied_coupon_id),
    'items', v_items
  );
end; $$;

revoke all on function public.get_cart_order_details(uuid) from public,anon;
grant execute on function public.get_cart_order_details(uuid) to authenticated,service_role;

commit;
