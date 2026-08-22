-- Loja administrativa: submenu "Pedidos" (/loja/pedidos + /loja/pedidos/[id]).
--
-- AUDITORIA PREVIA (nao criar fonte paralela):
--   - store_orders/store_order_items ja sao as tabelas corretas (nenhuma
--     tabela nova). RLS "store_orders_select" (remote_schema.sql) ja libera
--     select por user_can_access_organization -- mas NENHUMA policy de RLS
--     verifica store.view/store.deliver especificamente (so membership de
--     organizacao). Por isso as RPCs abaixo, como toda RPC admin do projeto,
--     fazem o proprio gate de permissao (current_user_has_permission) --
--     protecao real de BACKEND, nao so escondendo o link na UI.
--   - confirm_store_order_payment/cancel_store_order/deliver_store_order_item/
--     undo_store_order_item_delivery (RPCs ja existentes, ja usadas por
--     src/app/loja/actions.ts) NAO SAO TOCADAS -- reaproveitadas tal como
--     estao pelas novas telas.
--   - A causa raiz do gap "pedido de produto global some da equipe": o
--     /loja/page.tsx atual (a) so consulta store_orders quando ha
--     selectedEventId (sem evento selecionado, "orders" nem e buscado) e (b)
--     quando ha selectedEventId, filtra ".eq('event_id', selectedEventId)",
--     que NUNCA bate com NULL em SQL. As RPCs novas abaixo nunca fazem esse
--     filtro estrito -- p_event_id/p_global_only sao filtros OPCIONAIS
--     aplicados so quando o operador escolhe, nunca uma condicao que
--     descarta silenciosamente linhas com event_id null por padrao.
--   - Identidade do comprador: a mesma resolucao ja usada em list_admin_team
--     (auth.users + customer_profiles), com registration_contacts tendo
--     PRIORIDADE quando presente (comentario da propria migration
--     20260859000000: "identidade canonica e registration_contacts").
begin;

-- Lista (1 linha por pedido) para /loja/pedidos. Nunca filtra por event_id
-- IS NOT NULL por padrao -- pedido global (event_id null) sempre aparece,
-- a menos que o operador explicitamente peca so eventos ou so globais.
create or replace function public.list_store_orders_for_admin(
  p_status text default null,
  p_event_id uuid default null,
  p_global_only boolean default false,
  p_search text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
) returns table(
  store_order_id uuid, order_number text, status text, payment_method text, payment_status text,
  base_amount numeric, final_amount numeric, event_id uuid, event_name text,
  buyer_name text, buyer_email text, item_count integer, delivery_status text, created_at timestamptz
) language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_search text := lower(trim(coalesce(p_search, '')));
  v_status text := lower(trim(coalesce(p_status, '')));
begin
  if v_actor is null then raise exception 'Usuario autenticado obrigatorio.'; end if;
  if not (public.current_user_has_permission('store.view') or public.current_user_has_permission('store.deliver')) then
    raise exception 'Sem permissao para visualizar pedidos da loja.';
  end if;

  return query
  with buyer as (
    select
      so.id as store_order_id,
      coalesce(nullif(trim(rc.full_name), ''), nullif(trim(cp.full_name), ''), split_part(u.email, '@', 1)) as buyer_name,
      coalesce(rc.email, u.email) as buyer_email
    from public.store_orders so
    left join public.registration_contacts rc on rc.id = so.registration_contact_id
    left join auth.users u on u.id = so.user_id
    left join public.customer_profiles cp on cp.user_id = so.user_id
  ),
  items as (
    select
      soi.store_order_id,
      count(*)::integer as item_count,
      count(*) filter (where soi.status <> 'cancelled') as active_item_count,
      count(*) filter (where soi.status = 'delivered') as delivered_count
    from public.store_order_items soi
    group by soi.store_order_id
  )
  select
    so.id, so.order_number, so.status, so.payment_method, so.payment_status,
    so.base_amount, so.final_amount, so.event_id,
    coalesce(e.name, 'Produto global'),
    b.buyer_name, b.buyer_email,
    coalesce(i.item_count, 0),
    case
      when so.status = 'cancelled' then 'cancelled'
      when so.status <> 'confirmed' then 'not_applicable'
      when coalesce(i.active_item_count, 0) = 0 then 'not_applicable'
      when i.delivered_count = i.active_item_count then 'delivered'
      when i.delivered_count > 0 then 'partial'
      else 'pending'
    end as delivery_status,
    so.created_at
  from public.store_orders so
  left join public.events e on e.id = so.event_id
  left join buyer b on b.store_order_id = so.id
  left join items i on i.store_order_id = so.id
  where public.user_can_access_organization(v_actor, so.organization_id)
    and (p_event_id is null or so.event_id = p_event_id)
    and (not coalesce(p_global_only, false) or so.event_id is null)
    and (p_date_from is null or so.created_at >= p_date_from)
    and (p_date_to is null or so.created_at <= p_date_to)
    and (
      v_search = ''
      or so.order_number ilike '%' || v_search || '%'
      or lower(coalesce(b.buyer_name, '')) like '%' || v_search || '%'
      or lower(coalesce(b.buyer_email, '')) like '%' || v_search || '%'
    )
    and (
      v_status = '' or v_status = 'all'
      or (v_status = 'pending' and so.status = 'pending')
      or (v_status = 'confirmed' and so.status = 'confirmed')
      or (v_status = 'cancelled' and so.status = 'cancelled')
      or (v_status = 'to_deliver' and so.status = 'confirmed' and coalesce(i.active_item_count, 0) > 0 and i.delivered_count < i.active_item_count)
      or (v_status = 'delivered' and so.status = 'confirmed' and coalesce(i.active_item_count, 0) > 0 and i.delivered_count = i.active_item_count)
    )
  order by so.created_at desc
  limit 300;
end; $$;

revoke all on function public.list_store_orders_for_admin(text, uuid, boolean, text, timestamptz, timestamptz) from public;
grant execute on function public.list_store_orders_for_admin(text, uuid, boolean, text, timestamptz, timestamptz) to authenticated, service_role;

-- Detalhe completo de 1 pedido para /loja/pedidos/[orderId]: pedido,
-- comprador, itens (com produto/imagem/variante/preco/desconto/subtotal/
-- status de entrega/disponibilidade de QR) e historico (audit_logs de
-- criacao/entrega/cancelamento, com nome do ator resolvido).
create or replace function public.get_store_order_admin_detail(p_store_order_id uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_order public.store_orders%rowtype;
  v_event public.events%rowtype;
  v_buyer_name text;
  v_buyer_email text;
  v_buyer_phone text;
  v_items jsonb;
  v_history jsonb;
begin
  if v_actor is null then raise exception 'Usuario autenticado obrigatorio.'; end if;
  if not (public.current_user_has_permission('store.view') or public.current_user_has_permission('store.deliver')) then
    raise exception 'Sem permissao para visualizar pedidos da loja.';
  end if;

  select * into v_order from public.store_orders where id = p_store_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_order.organization_id) then
    raise exception 'Pedido invalido ou sem acesso.';
  end if;

  if v_order.event_id is not null then
    select * into v_event from public.events where id = v_order.event_id;
  end if;

  select
    coalesce(nullif(trim(rc.full_name), ''), nullif(trim(cp.full_name), ''), split_part(u.email, '@', 1)),
    coalesce(rc.email, u.email),
    coalesce(rc.phone, cp.phone)
  into v_buyer_name, v_buyer_email, v_buyer_phone
  from (select 1) as dummy
  left join public.registration_contacts rc on rc.id = v_order.registration_contact_id
  left join auth.users u on u.id = v_order.user_id
  left join public.customer_profiles cp on cp.user_id = v_order.user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', soi.id,
    'store_item_id', soi.store_item_id,
    'name', si.name,
    'image_url', (select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1),
    'variant_name', siv.name,
    'variant_value', siv.value,
    'quantity', soi.quantity,
    'unit_price', soi.unit_price,
    'discount_type', soi.discount_type,
    'discount_value', soi.discount_value,
    'final_unit_price', coalesce(soi.final_unit_price, soi.unit_price),
    'final_amount', soi.final_amount,
    'status', soi.status,
    'delivered_at', soi.delivered_at,
    'has_qr', (soi.qr_token is not null)
  ) order by si.sort_order, si.name), '[]'::jsonb)
  into v_items
  from public.store_order_items soi
  join public.store_items si on si.id = soi.store_item_id
  left join public.store_item_variants siv on siv.id = soi.variant_id
  where soi.store_order_id = p_store_order_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'action', al.action,
    'created_at', al.created_at,
    'actor_name', coalesce(nullif(trim(acp.full_name), ''), split_part(au.email, '@', 1), 'Sistema'),
    'details', al.details
  ) order by al.created_at desc), '[]'::jsonb)
  into v_history
  from public.audit_logs al
  left join auth.users au on au.id = nullif(al.details->>'actor_user_id', '')::uuid
  left join public.customer_profiles acp on acp.user_id = au.id
  where (al.entity_type = 'store_orders' and al.entity_id = p_store_order_id)
     or (al.entity_type = 'store_order_items' and al.entity_id in (
       select soi.id from public.store_order_items soi where soi.store_order_id = p_store_order_id
     ));

  return jsonb_build_object(
    'order', jsonb_build_object(
      'id', v_order.id, 'order_number', v_order.order_number, 'status', v_order.status,
      'payment_method', v_order.payment_method, 'payment_status', v_order.payment_status,
      'base_amount', v_order.base_amount, 'final_amount', v_order.final_amount,
      'discount_amount', round(v_order.base_amount - v_order.final_amount, 2),
      'pix_code', v_order.pix_code, 'pix_qrcode', v_order.pix_qrcode,
      'gateway_payment_id', v_order.gateway_payment_id, 'expires_at', v_order.expires_at, 'paid_at', v_order.paid_at,
      'confirmed_at', v_order.confirmed_at, 'cancelled_at', v_order.cancelled_at, 'created_at', v_order.created_at,
      'event_id', v_order.event_id, 'event_name', coalesce(v_event.name, 'Produto global')
    ),
    'buyer', jsonb_build_object(
      'name', v_buyer_name, 'email', v_buyer_email, 'phone', v_buyer_phone,
      'registration_contact_id', v_order.registration_contact_id, 'user_id', v_order.user_id
    ),
    'items', v_items,
    'history', v_history
  );
end; $$;

revoke all on function public.get_store_order_admin_detail(uuid) from public;
grant execute on function public.get_store_order_admin_detail(uuid) to authenticated, service_role;

commit;
