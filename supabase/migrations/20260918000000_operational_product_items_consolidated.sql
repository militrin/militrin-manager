-- Consolidacao de LEITURA (nunca de dados): produto vendido pela loja
-- standalone (store_orders/store_order_items) e produto "compre junto" do
-- checkout de ingresso (orders/order_items, item_kind='product') sao dois
-- dominios paralelos e desconectados por decisao de projeto (ver
-- 20260825000000/20260916000000/20260917000000) -- e continuam sendo.
--
-- INVESTIGACAO (resumo -- ver relatorio completo dado ao usuario fora desta
-- migration):
--   1. Loja -> Pedidos (src/app/loja/pedidos/page.tsx) chama list_store_orders_
--      for_admin (20260869000000), que SO consulta store_orders/store_order_items
--      -- por isso produto "compre junto" nunca aparecia la, mesmo entregue.
--   2. delivered_at existe em store_order_items (20260860000000) e em
--      order_items (20260917000000) -- ja e a fonte confiavel de "quando".
--   3. NENHUM dos dois dominios tem coluna propria de "quem entregou" --
--      deliver_store_order_item e deliver_order_item_product gravam so em
--      audit_logs.details->>'actor_user_id' (acoes 'store_order_item_delivered'
--      e 'order_item_product_delivered'). Como as duas RPCs sao IDEMPOTENTES
--      (retornam early em status='delivered', ANTES de qualquer INSERT), cada
--      item tem no maximo 1 linha de audit_logs daquela acao -- fonte
--      confiavel e unica pra "operador da PRIMEIRA entrega", sem precisar de
--      coluna nova. Esta migration NAO adiciona delivered_by -- reusa
--      audit_logs (auditoria ja existente) exatamente como pedido.
--
-- Esta migration cria list_operational_product_items: RPC de leitura pura
-- (nenhum INSERT/UPDATE/DELETE) que faz UNION ALL das duas fontes, devolvendo
-- 1 linha por item (nunca por pedido) com vocabulario normalizado
-- (delivery_status: not_applicable/to_deliver/delivered/cancelled -- MESMO
-- vocabulario ja usado por list_store_orders_for_admin, so aplicado por item
-- em vez de agregado por pedido). `source` ('store'|'checkout') e os ids
-- crus (item_id/order_id) sao preservados em cada linha, exatamente pra que
-- a camada de acao (entrega) saiba em qual dominio atuar -- nunca inferido,
-- sempre devolvido explicitamente.
begin;

create or replace function public.list_operational_product_items(
  p_status text default null,
  p_event_id uuid default null,
  p_search text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
) returns table(
  source text,
  item_id uuid,
  order_id uuid,
  order_number text,
  display_number bigint,
  product_name text,
  variant text,
  quantity integer,
  event_id uuid,
  event_name text,
  buyer text,
  payment_status text,
  delivery_status text,
  delivered_at timestamptz,
  delivered_by_user_id uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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
  with delivery_audit as (
    -- Idempotencia das RPCs de entrega garante no maximo 1 linha por
    -- (action, entity_id) -- nunca precisa de max()/first() pra desambiguar.
    select al.entity_id as item_id, nullif(al.details->>'actor_user_id', '')::uuid as actor_user_id
    from public.audit_logs al
    where al.action in ('store_order_item_delivered', 'order_item_product_delivered')
  ),
  store_rows as (
    select
      'store'::text as source,
      soi.id as item_id,
      so.id as order_id,
      so.order_number,
      so.display_number,
      si.name as product_name,
      case when siv.id is not null then siv.name || ': ' || siv.value else null end as variant,
      soi.quantity,
      so.event_id,
      coalesce(e.name, 'Produto global') as event_name,
      coalesce(nullif(trim(rc.full_name), ''), nullif(trim(cp.full_name), ''), split_part(u.email, '@', 1), 'Comprador não identificado') as buyer,
      so.status as payment_status,
      case
        when so.status = 'cancelled' or soi.status = 'cancelled' then 'cancelled'
        when so.status <> 'confirmed' then 'not_applicable'
        when soi.status = 'delivered' then 'delivered'
        else 'to_deliver'
      end as delivery_status,
      soi.delivered_at,
      da.actor_user_id as delivered_by_user_id,
      so.created_at,
      so.organization_id
    from public.store_order_items soi
    join public.store_orders so on so.id = soi.store_order_id
    join public.store_items si on si.id = soi.store_item_id
    left join public.store_item_variants siv on siv.id = soi.variant_id
    left join public.events e on e.id = so.event_id
    left join public.registration_contacts rc on rc.id = so.registration_contact_id
    left join public.customer_profiles cp on cp.user_id = so.user_id
    left join auth.users u on u.id = so.user_id
    left join delivery_audit da on da.item_id = soi.id
  ),
  checkout_rows as (
    select
      'checkout'::text as source,
      oi.id as item_id,
      o.id as order_id,
      o.order_number,
      o.display_number,
      si.name as product_name,
      case when siv.id is not null then siv.name || ': ' || siv.value else null end as variant,
      oi.quantity,
      oi.event_id,
      coalesce(e.name, 'Evento') as event_name,
      coalesce(nullif(trim(cp.full_name), ''), split_part(u.email, '@', 1), 'Comprador não identificado') as buyer,
      o.status as payment_status,
      case
        when o.status = 'cancelled' or oi.status in ('cancelled', 'expired', 'refunded', 'transferred') then 'cancelled'
        when o.status <> 'confirmed' then 'not_applicable'
        when oi.status = 'delivered' then 'delivered'
        else 'to_deliver'
      end as delivery_status,
      oi.delivered_at,
      da.actor_user_id as delivered_by_user_id,
      o.created_at,
      o.organization_id
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    join public.store_items si on si.id = oi.store_item_id
    left join public.store_item_variants siv on siv.id = oi.store_item_variant_id
    left join public.events e on e.id = oi.event_id
    left join public.customer_profiles cp on cp.user_id = o.user_id
    left join auth.users u on u.id = o.user_id
    left join delivery_audit da on da.item_id = oi.id
    where oi.item_kind = 'product'
  ),
  combined as (
    select * from store_rows
    union all
    select * from checkout_rows
  )
  select
    c.source, c.item_id, c.order_id, c.order_number, c.display_number,
    c.product_name, c.variant, c.quantity, c.event_id, c.event_name, c.buyer,
    c.payment_status, c.delivery_status, c.delivered_at, c.delivered_by_user_id, c.created_at
  from combined c
  where public.user_can_access_organization(v_actor, c.organization_id)
    and (p_event_id is null or c.event_id = p_event_id)
    and (p_date_from is null or c.created_at >= p_date_from)
    and (p_date_to is null or c.created_at <= p_date_to)
    and (
      v_search = ''
      or c.order_number ilike '%' || v_search || '%'
      or lower(coalesce(c.buyer, '')) like '%' || v_search || '%'
    )
    and (
      v_status = '' or v_status = 'all'
      or (v_status = 'pending' and c.payment_status = 'pending')
      or (v_status = 'confirmed' and c.payment_status = 'confirmed')
      or (v_status = 'cancelled' and c.delivery_status = 'cancelled')
      or (v_status = 'to_deliver' and c.delivery_status = 'to_deliver')
      or (v_status = 'delivered' and c.delivery_status = 'delivered')
    )
  order by c.created_at desc
  limit 300;
end;
$$;

revoke all on function public.list_operational_product_items(text, uuid, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.list_operational_product_items(text, uuid, text, timestamptz, timestamptz) to authenticated, service_role;

commit;
