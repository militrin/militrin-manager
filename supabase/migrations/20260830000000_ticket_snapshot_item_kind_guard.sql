-- get_order_checkout_snapshot alimenta a tela pos-pedido de INGRESSO (QR,
-- status do titular, categoria, camiseta) e nao filtrava order_items por
-- item_kind. Com a introducao de linhas de produto ("compre junto") no
-- mesmo pedido, essa RPC passaria a incluir linhas de produto misturadas na
-- lista de ingressos (shirt_type/category_name nulos, item_position nulo),
-- quebrando visualmente uma tela que ja funciona hoje. Corrigido restando
-- este snapshot ao seu proposito original -- so linhas de ingresso. Zero
-- impacto em pedidos existentes (todo order_item pre-existente ja e
-- item_kind='ticket' por default).
begin;

create or replace function public.get_order_checkout_snapshot(p_order_id uuid)
 RETURNS TABLE(order_id uuid, order_number text, order_status text, payment_id uuid, payment_status text, payment_method text, amount numeric, discount_amount numeric, final_amount numeric, expires_at timestamp with time zone, pix_code text, pix_qrcode text, gateway_payment_id text, paid_at timestamp with time zone, event_id uuid, event_name text, item_id uuid, item_position integer, item_status text, ownership_status text, participant_id uuid, participant_name text, holder_full_name text, ticket_id uuid, ticket_status text, ticket_token uuid, shirt_type text, shirt_size text, category_name text, batch_name text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    o.id as order_id,
    o.order_number,
    o.status as order_status,
    pay.id as payment_id,
    pay.payment_status,
    pay.payment_method,
    pay.amount,
    pay.discount_amount,
    pay.final_amount,
    pay.expires_at,
    pay.pix_code,
    pay.pix_qrcode,
    pay.gateway_payment_id,
    pay.paid_at,
    o.event_id,
    e.name as event_name,
    oi.id as item_id,
    oi.item_position,
    oi.status as item_status,
    oi.ownership_status,
    oi.participant_id,
    p.full_name as participant_name,
    oi.holder_full_name,
    t.id as ticket_id,
    t.status as ticket_status,
    t.token as ticket_token,
    oi.shirt_type,
    oi.shirt_size,
    tc.name as category_name,
    rb.name as batch_name
  from public.orders o
  join public.payments pay
    on pay.order_id = o.id
  join public.order_items oi
    on oi.order_id = o.id
    and oi.item_kind = 'ticket'
  join public.events e
    on e.id = o.event_id
  left join public.participants p
    on p.id = oi.participant_id
  left join public.tickets t
    on t.order_item_id = oi.id
  left join public.ticket_categories tc
    on tc.id = oi.ticket_category_id
  left join public.registration_batches rb
    on rb.id = oi.batch_id
  where o.id = p_order_id
    and (
      auth.uid() = o.user_id
      or public.current_user_has_permission('participants.view'::text)
    )
  order by coalesce(oi.item_position, 999999), oi.created_at;
$function$;

commit;
