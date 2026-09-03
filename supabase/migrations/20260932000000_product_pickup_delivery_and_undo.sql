-- FEATURE (4/10): entrega e undo para os 3 modos de pickup_qr_mode.
--
--   per_line (comportamento historico): deliver_order_item_product /
--   deliver_store_order_item continuam entregando a linha inteira de uma
--   vez, sem mudanca de corpo alem da guarda nova abaixo.
--
--   per_unit (QUALQUER quantity, ver migration 1/2 -- modelo unico, sem
--   excecao pra quantity=1): as RPCs de linha REJEITAM a entrega
--   incondicionalmente quando pickup_qr_mode='per_unit' -- a linha nunca e
--   a identidade de retirada nesse modo, so a unidade. Novas RPCs
--   deliver_order_item_pickup_unit/deliver_store_order_item_pickup_unit
--   entregam 1 unidade por vez, idempotentes, e sincronizam a linha-mae
--   pra 'delivered' quando a ultima unidade pendente e entregue (mantem
--   quem so olha a linha consistente).
--
--   none: RPCs de linha rejeitam explicitamente -- forcam o uso da tela
--   "Loja > Pedidos" (list_operational_product_items, ja existe, nao
--   depende de QR).
--
-- Undo com motivo obrigatorio replica undo_ticket_checkin/
-- validate_operation_reason_code (20260848000000) linha a linha, com
-- permissao PROPRIA (store.undo_delivery, criada aqui) -- nunca reaproveita
-- store.deliver pra desfazer, mesmo racional ja usado pra checkin.scan vs
-- checkin.undo e kits.deliver vs kits.undo_delivery.
begin;

-- ============================================================
-- 1) nova permissao store.undo_delivery
-- ============================================================
insert into public.admin_permissions (code, name, description, module, sort_order, is_active)
values ('store.undo_delivery', 'Desfazer entrega de item da loja', 'Permite reverter a entrega/retirada de um item (linha ou unidade) da loja ou "compre junto", sempre com motivo obrigatorio', 'store', 35, true)
on conflict (code) do update set
  name = excluded.name, description = excluded.description, module = excluded.module,
  sort_order = excluded.sort_order, is_active = excluded.is_active;

insert into public.admin_role_permissions (role_id, permission_id)
select role.id, permission.id
from public.admin_roles role
join public.admin_permissions permission on permission.code = 'store.undo_delivery'
where role.code = 'administrator'
on conflict (role_id, permission_id) do nothing;

-- ============================================================
-- 2) deliver_order_item_product -- guarda nova pro modo 'none' e pro modo
--    'per_unit' (incondicional -- sempre rejeita, nunca depende de existir
--    unidade materializada). Resto do corpo identico a versao vigente
--    (20260917000000).
-- ============================================================
create or replace function public.deliver_order_item_product(p_order_item_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then
    raise exception 'Sem permissao para entregar itens da loja.';
  end if;

  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  if v_item.item_kind <> 'product' then raise exception 'Item nao e um produto "compre junto".'; end if;

  select * into v_order from public.orders where id = v_item.order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then
    raise exception 'Pedido invalido ou sem acesso.';
  end if;

  if coalesce(v_item.pickup_qr_mode, 'per_line') = 'none' then
    raise exception 'Este produto nao usa QR de retirada -- confirme a entrega pela lista de pedidos.';
  end if;
  if coalesce(v_item.pickup_qr_mode, 'per_line') = 'per_unit' then
    raise exception 'Este item usa QR por unidade -- entregue cada unidade individualmente.';
  end if;

  if v_item.status = 'delivered' then return true; end if;
  if v_item.status <> 'confirmed' then raise exception 'Item precisa estar confirmado (pago) para ser entregue.'; end if;

  perform public.deliver_store_item_stock(v_item.store_item_id, v_item.store_item_variant_id, v_item.quantity);

  update public.order_items set status = 'delivered', delivered_at = now(), updated_at = now() where id = v_item.id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('order_item_product_delivered', 'order_items', v_item.id, v_item.event_id, jsonb_build_object(
    'actor_user_id', auth.uid(), 'order_id', v_order.id, 'store_item_id', v_item.store_item_id,
    'store_item_variant_id', v_item.store_item_variant_id, 'quantity', v_item.quantity
  ));

  return true;
end;
$$;

-- ============================================================
-- 3) deliver_store_order_item -- mesma guarda, mesmo padrao.
-- ============================================================
create or replace function public.deliver_store_order_item(p_store_order_item_id uuid) returns boolean
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare v_line public.store_order_items%rowtype; v_order public.store_orders%rowtype;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para entregar itens da loja.'; end if;
  select * into v_line from public.store_order_items where id = p_store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;

  if v_line.pickup_qr_mode = 'none' then
    raise exception 'Este produto nao usa QR de retirada -- confirme a entrega pela lista de pedidos.';
  end if;
  if v_line.pickup_qr_mode = 'per_unit' then
    raise exception 'Este item usa QR por unidade -- entregue cada unidade individualmente.';
  end if;

  if v_line.status = 'delivered' then return true; end if;
  if v_line.status <> 'confirmed' then raise exception 'Item precisa estar confirmado (pago) para ser entregue.'; end if;

  perform public.deliver_store_item_stock(v_line.store_item_id, v_line.variant_id, v_line.quantity);

  update public.store_order_items set status = 'delivered', delivered_at = now() where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivered', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object('actor_user_id', auth.uid()));
  return true;
end; $$;

-- ============================================================
-- 4) deliver_order_item_pickup_unit / deliver_store_order_item_pickup_unit
--    -- novas RPCs, entregam 1 unidade por vez, idempotentes. Baixa de
--    estoque por unidade (quantity=1 por chamada -- reusa
--    deliver_store_item_stock, a MESMA funcao ja usada pelas RPCs de
--    linha, nunca uma baixa paralela). Quando a ultima unidade pendente e
--    entregue, sincroniza a linha-mae para 'delivered' tambem.
-- ============================================================
create or replace function public.deliver_order_item_pickup_unit(p_unit_id uuid)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_unit public.order_item_pickup_units%rowtype;
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_pending_count integer;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para entregar itens da loja.'; end if;

  select * into v_unit from public.order_item_pickup_units where id = p_unit_id for update;
  if not found then raise exception 'Unidade nao encontrada.'; end if;
  select * into v_item from public.order_items where id = v_unit.order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.orders where id = v_item.order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then
    raise exception 'Pedido invalido ou sem acesso.';
  end if;

  if v_unit.status = 'delivered' then return true; end if;
  if v_unit.status <> 'confirmed' then raise exception 'Unidade precisa estar confirmada (pedido pago) para ser entregue.'; end if;

  perform public.deliver_store_item_stock(v_item.store_item_id, v_item.store_item_variant_id, 1);

  update public.order_item_pickup_units set status = 'delivered', delivered_at = now(), updated_at = now() where id = v_unit.id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('order_item_pickup_unit_delivered', 'order_item_pickup_units', v_unit.id, v_item.event_id, jsonb_build_object(
    'actor_user_id', auth.uid(), 'order_item_id', v_item.id, 'unit_index', v_unit.unit_index,
    'store_item_id', v_item.store_item_id, 'store_item_variant_id', v_item.store_item_variant_id));

  select count(*) into v_pending_count from public.order_item_pickup_units
  where order_item_id = v_item.id and status <> 'delivered';
  if v_pending_count = 0 and v_item.status <> 'delivered' then
    update public.order_items set status = 'delivered', delivered_at = now(), updated_at = now() where id = v_item.id;
  end if;

  return true;
end; $$;

create or replace function public.deliver_store_order_item_pickup_unit(p_unit_id uuid)
returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_unit public.store_order_item_pickup_units%rowtype;
  v_line public.store_order_items%rowtype;
  v_order public.store_orders%rowtype;
  v_pending_count integer;
begin
  if not public.current_user_has_permission('store.deliver') then raise exception 'Sem permissao para entregar itens da loja.'; end if;

  select * into v_unit from public.store_order_item_pickup_units where id = p_unit_id for update;
  if not found then raise exception 'Unidade nao encontrada.'; end if;
  select * into v_line from public.store_order_items where id = v_unit.store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then
    raise exception 'Pedido invalido ou sem acesso.';
  end if;

  if v_unit.status = 'delivered' then return true; end if;
  if v_unit.status <> 'confirmed' then raise exception 'Unidade precisa estar confirmada (pedido pago) para ser entregue.'; end if;

  perform public.deliver_store_item_stock(v_line.store_item_id, v_line.variant_id, 1);

  update public.store_order_item_pickup_units set status = 'delivered', delivered_at = now(), updated_at = now() where id = v_unit.id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('store_order_item_pickup_unit_delivered', 'store_order_item_pickup_units', v_unit.id, v_order.event_id, jsonb_build_object(
    'actor_user_id', auth.uid(), 'store_order_item_id', v_line.id, 'unit_index', v_unit.unit_index,
    'store_item_id', v_line.store_item_id, 'variant_id', v_line.variant_id));

  select count(*) into v_pending_count from public.store_order_item_pickup_units
  where store_order_item_id = v_line.id and status <> 'delivered';
  if v_pending_count = 0 and v_line.status <> 'delivered' then
    update public.store_order_items set status = 'delivered', delivered_at = now() where id = v_line.id;
  end if;

  return true;
end; $$;

-- ============================================================
-- 5) undo com motivo obrigatorio -- linha e unidade, nos 2 dominios.
--    undo_store_order_item_delivery muda de assinatura (ganha motivo) --
--    precisa de drop explicito da versao antiga (uuid), que so existia sem
--    motivo desde 20260854000000.
-- ============================================================
create or replace function public.undo_order_item_product_delivery(
  p_order_item_id uuid, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if not public.current_user_has_permission('store.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
  perform public.validate_operation_reason_code(p_reason_code, p_reason_text);

  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  if v_item.item_kind <> 'product' then raise exception 'Item nao e um produto "compre junto".'; end if;
  select * into v_order from public.orders where id = v_item.order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_item.status <> 'delivered' then raise exception 'Item nao esta entregue.'; end if;

  perform public.undo_deliver_store_item_stock(v_item.store_item_id, v_item.store_item_variant_id, v_item.quantity);

  update public.order_items set status = 'confirmed', delivered_at = null, updated_at = now() where id = v_item.id;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('order_item_product_delivery_undone', 'order_items', v_item.id, v_item.event_id, jsonb_build_object(
    'actor_user_id', auth.uid(), 'actor_email', v_actor_email, 'order_id', v_order.id,
    'store_item_id', v_item.store_item_id, 'store_item_variant_id', v_item.store_item_variant_id, 'quantity', v_item.quantity,
    'reason_code', p_reason_code, 'reason_text', nullif(trim(coalesce(p_reason_text,'')),'')));

  return true;
end; $$;

drop function if exists public.undo_store_order_item_delivery(uuid);

create or replace function public.undo_store_order_item_delivery(
  p_store_order_item_id uuid, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_line public.store_order_items%rowtype;
  v_order public.store_orders%rowtype;
  v_actor_email text := coalesce((select lower(u.email) from auth.users u where u.id = auth.uid()), 'system');
begin
  if not public.current_user_has_permission('store.undo_delivery') then raise exception 'Sem permissao para desfazer entrega da loja.'; end if;
  perform public.validate_operation_reason_code(p_reason_code, p_reason_text);

  select * into v_line from public.store_order_items where id = p_store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_line.status <> 'delivered' then raise exception 'Item nao esta entregue.'; end if;

  perform public.undo_deliver_store_item_stock(v_line.store_item_id, v_line.variant_id, v_line.quantity);

  update public.store_order_items set status = 'confirmed', delivered_at = null where id = v_line.id;
  insert into public.audit_logs (action, entity_type, entity_id, event_id, details)
  values ('store_order_item_delivery_undone', 'store_order_items', v_line.id, v_order.event_id, jsonb_build_object(
    'actor_user_id', auth.uid(), 'actor_email', v_actor_email,
    'reason_code', p_reason_code, 'reason_text', nullif(trim(coalesce(p_reason_text,'')),'')));
  return true;
end; $$;

create or replace function public.undo_order_item_pickup_unit_delivery(
  p_unit_id uuid, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_unit public.order_item_pickup_units%rowtype;
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
begin
  if not public.current_user_has_permission('store.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
  perform public.validate_operation_reason_code(p_reason_code, p_reason_text);

  select * into v_unit from public.order_item_pickup_units where id = p_unit_id for update;
  if not found then raise exception 'Unidade nao encontrada.'; end if;
  select * into v_item from public.order_items where id = v_unit.order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.orders where id = v_item.order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_unit.status <> 'delivered' then raise exception 'Unidade nao esta entregue.'; end if;

  perform public.undo_deliver_store_item_stock(v_item.store_item_id, v_item.store_item_variant_id, 1);

  update public.order_item_pickup_units set status = 'confirmed', delivered_at = null, updated_at = now() where id = v_unit.id;

  -- Se a linha-mae estava marcada 'delivered' (todas as unidades entregues),
  -- desfazer uma unidade tem que regredir a linha tambem -- nunca fica
  -- 'delivered' com uma unidade pendente.
  if v_item.status = 'delivered' then
    update public.order_items set status = 'confirmed', delivered_at = null, updated_at = now() where id = v_item.id;
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('order_item_pickup_unit_delivery_undone', 'order_item_pickup_units', v_unit.id, v_item.event_id, jsonb_build_object(
    'actor_user_id', auth.uid(), 'order_item_id', v_item.id, 'unit_index', v_unit.unit_index,
    'reason_code', p_reason_code, 'reason_text', nullif(trim(coalesce(p_reason_text,'')),'')));

  return true;
end; $$;

create or replace function public.undo_store_order_item_pickup_unit_delivery(
  p_unit_id uuid, p_reason_code text, p_reason_text text default null
) returns boolean language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_unit public.store_order_item_pickup_units%rowtype;
  v_line public.store_order_items%rowtype;
  v_order public.store_orders%rowtype;
begin
  if not public.current_user_has_permission('store.undo_delivery') then raise exception 'Sem permissao para desfazer entrega.'; end if;
  perform public.validate_operation_reason_code(p_reason_code, p_reason_text);

  select * into v_unit from public.store_order_item_pickup_units where id = p_unit_id for update;
  if not found then raise exception 'Unidade nao encontrada.'; end if;
  select * into v_line from public.store_order_items where id = v_unit.store_order_item_id for update;
  if not found then raise exception 'Item de pedido nao encontrado.'; end if;
  select * into v_order from public.store_orders where id = v_line.store_order_id;
  if not found or not public.user_can_access_organization(auth.uid(), v_order.organization_id) then raise exception 'Pedido invalido ou sem acesso.'; end if;
  if v_unit.status <> 'delivered' then raise exception 'Unidade nao esta entregue.'; end if;

  perform public.undo_deliver_store_item_stock(v_line.store_item_id, v_line.variant_id, 1);

  update public.store_order_item_pickup_units set status = 'confirmed', delivered_at = null, updated_at = now() where id = v_unit.id;

  if v_line.status = 'delivered' then
    update public.store_order_items set status = 'confirmed', delivered_at = null where id = v_line.id;
  end if;

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('store_order_item_pickup_unit_delivery_undone', 'store_order_item_pickup_units', v_unit.id, v_order.event_id, jsonb_build_object(
    'actor_user_id', auth.uid(), 'store_order_item_id', v_line.id, 'unit_index', v_unit.unit_index,
    'reason_code', p_reason_code, 'reason_text', nullif(trim(coalesce(p_reason_text,'')),'')));

  return true;
end; $$;

revoke all on function public.deliver_order_item_pickup_unit(uuid) from public, anon;
grant execute on function public.deliver_order_item_pickup_unit(uuid) to authenticated, service_role;
revoke all on function public.deliver_store_order_item_pickup_unit(uuid) from public, anon;
grant execute on function public.deliver_store_order_item_pickup_unit(uuid) to authenticated, service_role;
revoke all on function public.undo_order_item_product_delivery(uuid, text, text) from public, anon;
grant execute on function public.undo_order_item_product_delivery(uuid, text, text) to authenticated, service_role;
revoke all on function public.undo_store_order_item_delivery(uuid, text, text) from public, anon;
grant execute on function public.undo_store_order_item_delivery(uuid, text, text) to authenticated, service_role;
revoke all on function public.undo_order_item_pickup_unit_delivery(uuid, text, text) from public, anon;
grant execute on function public.undo_order_item_pickup_unit_delivery(uuid, text, text) to authenticated, service_role;
revoke all on function public.undo_store_order_item_pickup_unit_delivery(uuid, text, text) from public, anon;
grant execute on function public.undo_store_order_item_pickup_unit_delivery(uuid, text, text) to authenticated, service_role;

commit;
