-- FEATURE (10/10): list_operational_product_items (tela "Loja > Pedidos")
-- passa a devolver pickup_qr_mode de cada item -- o consumidor TS
-- (src/app/loja/pedidos/page.tsx) monta um OperationalProductItem por
-- linha, e esse tipo agora exige o campo (junto com parent_item_id/
-- unit_index, sempre null aqui: esta lista e sempre por LINHA, nunca por
-- unidade).
--
-- ATENCAO (achado na revisao desta sessao, corrigido aqui): a lista de
-- colunas de RETURNS TABLE muda (ganha pickup_qr_mode) -- Postgres NAO
-- permite CREATE OR REPLACE FUNCTION mudar o tipo de retorno de uma
-- funcao existente (a tentativa anterior desta migration usava so CREATE
-- OR REPLACE, o que teria falhado com "cannot change return type of
-- existing function" ao aplicar contra qualquer banco que ja tivesse a
-- versao de 20260918000000). Corrigido com DROP explicito da assinatura
-- antiga antes do CREATE, mesma disciplina ja usada em outras migrations
-- desta feature (upsert_store_item, undo_store_order_item_delivery) pra
-- mudanca de assinatura/retorno.
begin;

drop function if exists public.list_operational_product_items(text, uuid, text, timestamptz, timestamptz);

create function public.list_operational_product_items(
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
  created_at timestamptz,
  pickup_qr_mode text
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
      so.organization_id,
      soi.pickup_qr_mode
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
      o.organization_id,
      coalesce(oi.pickup_qr_mode, 'per_line') as pickup_qr_mode
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
    c.payment_status, c.delivery_status, c.delivered_at, c.delivered_by_user_id, c.created_at,
    c.pickup_qr_mode
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
