-- FEATURE (9/10): cancel_store_order ganha guarda estendida -- bloqueia
-- tambem quando ha QUALQUER unidade ja entregue (nao so linha inteira
-- 'delivered'; com o modo per_unit uma linha pode ter algumas unidades
-- entregues e ainda assim status 'confirmed', ja que a linha so vira
-- 'delivered' quando TODAS as unidades sao entregues) -- e cascata de
-- cancelamento pras unidades das linhas efetivamente canceladas.
-- Redefinida a partir da versao vigente (20260854000000) -- corpo
-- original preservado, so as adicoes descritas.
begin;

create or replace function public.cancel_store_order(p_store_order_id uuid, p_reason text) returns void
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_actor uuid := auth.uid(); v_order public.store_orders%rowtype; v_line record;
begin
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.current_user_has_permission('store.manage')) then raise exception 'Sem permissao para cancelar este pedido.'; end if;
  if v_order.status = 'cancelled' then return; end if;
  if exists (select 1 from public.store_order_items where store_order_id = p_store_order_id and status = 'delivered') then
    raise exception 'Pedido possui item entregue; nao pode ser cancelado.';
  end if;
  if exists (
    select 1 from public.store_order_item_pickup_units u
    join public.store_order_items soi on soi.id = u.store_order_item_id
    where soi.store_order_id = p_store_order_id and u.status = 'delivered'
  ) then
    raise exception 'Pedido possui unidade de item ja entregue; nao pode ser cancelado.';
  end if;

  for v_line in select * from public.store_order_items where store_order_id = p_store_order_id and status <> 'cancelled' for update loop
    perform public.release_store_item_reservation(v_line.store_item_id, v_line.variant_id, v_line.quantity);
    update public.store_order_items set status = 'cancelled' where id = v_line.id;
    update public.store_order_item_pickup_units set status = 'cancelled', updated_at = now()
    where store_order_item_id = v_line.id and status <> 'delivered';
  end loop;

  update public.store_orders set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = p_store_order_id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_cancelled', 'store_orders', p_store_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'reason', p_reason));
end; $$;

commit;
