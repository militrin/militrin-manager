-- Permissao dedicada para concessao administrativa. Entrega continua
-- protegida exclusivamente por store.deliver; operadores de kit/check-in nao
-- recebem capacidade de criar pedidos da loja.

insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values ('store.grant_items', 'Conceder itens da loja', 'Concede ou vende administrativamente produtos adicionais para participantes', 'store', 25, true)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  module = excluded.module,
  sort_order = excluded.sort_order,
  is_active = excluded.is_active;

insert into public.admin_role_permissions (role_id, permission_id)
select role.id, permission.id
from public.admin_roles role
join public.admin_permissions permission on permission.code = 'store.grant_items'
where role.code = 'administrator'
on conflict (role_id, permission_id) do nothing;

create or replace function public.admin_grant_store_item(
  p_ticket_id uuid, p_store_item_id uuid, p_variant_id uuid, p_quantity integer,
  p_is_courtesy boolean, p_reason text default null
) returns uuid language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_ticket public.tickets%rowtype; v_oi public.order_items%rowtype; v_order public.orders%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_participant_id uuid; v_unit_price numeric; v_final_unit_price numeric; v_line_total numeric; v_order_id uuid; v_order_number text; v_item_id uuid;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if v_actor is null or not (
    public.current_user_has_permission('store.grant_items')
    or public.current_user_has_permission('store.manage')
  ) then raise exception 'Sem permissao para conceder itens da loja.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;

  select * into v_ticket from public.tickets where id = p_ticket_id for update;
  if not found or not public.user_can_access_organization(v_actor, v_ticket.organization_id) then raise exception 'Ingresso invalido ou sem acesso.'; end if;
  select * into v_oi from public.order_items where id = v_ticket.order_item_id;
  v_participant_id := coalesce(v_oi.participant_id, v_ticket.participant_id);
  select * into strict v_order from public.orders where id = v_ticket.order_id;

  select * into v_store_item from public.store_items where id = p_store_item_id
    and (event_id = v_ticket.event_id or event_id is null) and is_active and organization_id = v_ticket.organization_id;
  if not found then raise exception 'Item da loja indisponivel para este evento.'; end if;
  if v_store_item.requires_variant and p_variant_id is null then raise exception 'Item exige selecao de variante.'; end if;

  v_unit_price := v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o item.'; end if;
    v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
  end if;
  v_final_unit_price := public.compute_store_item_final_price(v_unit_price, v_store_item.discount_type, v_store_item.discount_value);

  perform public.reserve_store_item_stock(v_store_item.id, p_variant_id, p_quantity);

  v_line_total := case when coalesce(p_is_courtesy, false) then 0 else round(v_final_unit_price * p_quantity, 2) end;
  v_order_number := 'ADMIN-' || to_char(now(), 'YYYYMMDD') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.store_orders (organization_id, event_id, user_id, participant_id, order_number, status, payment_method, payment_status, base_amount, final_amount, notes, confirmed_at)
  values (v_ticket.organization_id, v_ticket.event_id, v_order.user_id, v_participant_id, v_order_number,
    case when coalesce(p_is_courtesy, false) then 'confirmed' else 'pending' end,
    case when coalesce(p_is_courtesy, false) then 'admin_courtesy' else 'admin_charge' end,
    case when coalesce(p_is_courtesy, false) then 'paid' else 'pending' end,
    v_line_total, v_line_total,
    nullif(trim(coalesce(p_reason, '')), ''), case when coalesce(p_is_courtesy, false) then now() end)
  returning id into v_order_id;

  insert into public.store_order_items (store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status, discount_type, discount_value, final_unit_price)
  values (v_order_id, v_store_item.id, p_variant_id, p_quantity,
    case when coalesce(p_is_courtesy, false) then 0 else v_unit_price end, v_line_total,
    case when coalesce(p_is_courtesy, false) then 'confirmed' else 'reserved' end,
    v_store_item.discount_type, v_store_item.discount_value, case when coalesce(p_is_courtesy, false) then 0 else v_final_unit_price end)
  returning id into v_item_id;

  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_item_admin_granted', 'store_order_items', v_item_id, v_ticket.event_id,
    jsonb_build_object('actor_user_id', v_actor, 'actor_email', v_actor_email, 'ticket_id', v_ticket.id, 'participant_id', v_participant_id,
      'store_order_id', v_order_id, 'store_item_id', v_store_item.id, 'store_item_name', v_store_item.name,
      'variant_id', p_variant_id, 'quantity', p_quantity, 'is_courtesy', coalesce(p_is_courtesy, false), 'unit_price', v_unit_price,
      'final_amount', v_line_total, 'origin', 'admin', 'reason', nullif(trim(coalesce(p_reason,'')),''),
      'linked_event_kit_item_id', v_store_item.linked_event_kit_item_id));

  return v_item_id;
end; $$;

revoke all on function public.admin_grant_store_item(uuid, uuid, uuid, integer, boolean, text) from public, anon;
grant execute on function public.admin_grant_store_item(uuid, uuid, uuid, integer, boolean, text) to authenticated, service_role;
