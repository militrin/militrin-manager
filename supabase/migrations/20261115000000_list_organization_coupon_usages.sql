-- Historico administrativo de utilizacoes de cupom.
-- SOMENTE LEITURA. Nao altera used_count, pedidos, pagamentos nem a regra
-- de consumo: a fonte canonica continua sendo orders.applied_coupon_id
-- (1 uso por pedido no momento em que apply_cart_coupon grava o cupom).
-- Pagamento e informacao adicional -- pedido expirado/nao pago continua
-- listado enquanto applied_coupon_id apontar para o cupom.

begin;

create index if not exists idx_orders_applied_coupon_id
  on public.orders (applied_coupon_id)
  where applied_coupon_id is not null;

create or replace function public.list_organization_coupon_usages(p_coupon_id uuid)
returns table(
  order_id uuid,
  display_number bigint,
  order_number text,
  order_status text,
  buyer_type text,
  user_id uuid,
  contact_id uuid,
  contact_name text,
  contact_email text,
  buyer_name text,
  buyer_email text,
  applied_at timestamptz,
  original_amount numeric,
  discount_amount numeric,
  after_discount_amount numeric,
  payment_status text,
  payment_method text,
  payment_paid_at timestamptz,
  payment_final_amount numeric,
  payment_fee_customer_amount numeric,
  settlement_nature text,
  provider text,
  gateway_payment_id text,
  gateway_account_key text,
  gateway_environment text,
  off_gateway_method text,
  off_gateway_amount numeric,
  off_gateway_recorded_at timestamptz,
  reservation_expires_at timestamptz,
  price_origin text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_coupon public.coupons%rowtype;
begin
  if v_actor is null or not public.current_user_has_permission('coupons.view') then
    raise exception 'Sem permissao para consultar utilizacoes de cupons.';
  end if;

  select * into v_coupon from public.coupons where id = p_coupon_id;
  if not found then raise exception 'Cupom nao encontrado.'; end if;
  if not public.user_can_access_organization(v_actor, v_coupon.organization_id) then
    raise exception 'Sem acesso a organizacao.';
  end if;

  return query
  select
    o.id,
    o.display_number,
    o.order_number,
    o.status,
    o.buyer_type,
    o.user_id,
    contact.id,
    contact.full_name,
    contact.email,
    coalesce(contact.full_name, cp.full_name),
    coalesce(nullif(trim(contact.email), ''), lower(au.email::text)),
    coalesce(
      (
        select max(oid.created_at)
        from public.order_item_discounts oid
        join public.order_items oi on oi.id = oid.order_item_id
        where oi.order_id = o.id and oid.coupon_id = p_coupon_id
      ),
      (
        select max(al.created_at)
        from public.audit_logs al
        where al.entity_type = 'orders'
          and al.entity_id = o.id
          and al.action = 'cart_coupon_applied'
          and (
            al.details->>'coupon_id' = p_coupon_id::text
            or upper(coalesce(al.details->>'coupon_code', '')) = v_coupon.code
          )
      ),
      o.created_at
    ),
    coalesce(
      (
        select sum(oid.base_amount)
        from public.order_item_discounts oid
        join public.order_items oi on oi.id = oid.order_item_id
        where oi.order_id = o.id and oid.coupon_id = p_coupon_id
      ),
      o.base_amount
    ),
    o.discount_amount,
    o.final_amount,
    pay.payment_status,
    pay.payment_method,
    pay.paid_at,
    pay.final_amount,
    pay.payment_fee_customer_amount,
    pay.settlement_nature,
    pay.provider,
    pay.gateway_payment_id,
    pay.gateway_account_key,
    pay.gateway_environment,
    pay.off_gateway_method,
    pay.off_gateway_amount,
    pay.off_gateway_recorded_at,
    (
      select min(oi.reservation_expires_at)
      from public.order_items oi
      where oi.order_id = o.id
    ),
    coalesce(pay.price_origin, o.price_origin)
  from public.orders o
  left join public.customer_profiles cp on cp.user_id = o.user_id
  left join auth.users au on au.id = o.user_id
  left join lateral (
    select rc.id, rc.full_name, rc.email
    from public.registration_contacts rc
    where rc.organization_id = v_coupon.organization_id
      and rc.user_id = o.user_id
    order by rc.created_at asc, rc.id asc
    limit 1
  ) contact on true
  left join lateral (
    select p.*
    from public.payments p
    where p.order_id = o.id
    order by p.created_at desc, p.id desc
    limit 1
  ) pay on true
  where o.applied_coupon_id = p_coupon_id
    and o.organization_id = v_coupon.organization_id
  order by coalesce(
    (
      select max(oid.created_at)
      from public.order_item_discounts oid
      join public.order_items oi on oi.id = oid.order_item_id
      where oi.order_id = o.id and oid.coupon_id = p_coupon_id
    ),
    o.created_at
  ) desc, o.display_number desc, o.id;
end;
$$;

comment on function public.list_organization_coupon_usages(uuid) is
  'Somente leitura. Lista pedidos que consomem o cupom via orders.applied_coupon_id. Nao incrementa nem devolve used_count. Pagamento e dado adicional.';

revoke all on function public.list_organization_coupon_usages(uuid) from public, anon;
grant execute on function public.list_organization_coupon_usages(uuid) to authenticated, service_role;

commit;
