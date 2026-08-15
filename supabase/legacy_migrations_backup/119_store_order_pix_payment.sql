-- 119_store_order_pix_payment.sql
-- Gera PIX de verdade para pedidos da Loja do Evento, reaproveitando o mesmo
-- paymentProvider (src/lib/payments/*) ja usado no checkout de ingresso.
-- store_orders ganha as mesmas colunas de PIX que "payments" ja tem para
-- pedidos de ingresso, mantendo a loja isolada (sem depender da tabela
-- payments, que exige participant_id not null).

begin;

alter table public.store_orders
  add column if not exists pix_code text,
  add column if not exists pix_qrcode text,
  add column if not exists gateway_payment_id text,
  add column if not exists expires_at timestamptz,
  add column if not exists paid_at timestamptz;

create or replace function public.start_store_order_payment_pix(
  p_store_order_id uuid, p_pix_code text, p_pix_qrcode text, p_gateway_payment_id text, p_expires_at timestamptz
)
returns public.store_orders
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_order public.store_orders%rowtype;
begin
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if v_order.user_id <> v_actor then raise exception 'Sem permissao para alterar pagamento deste pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta pendente de pagamento.'; end if;

  update public.store_orders set
    payment_method = 'pix', pix_code = p_pix_code, pix_qrcode = p_pix_qrcode,
    gateway_payment_id = p_gateway_payment_id, expires_at = p_expires_at, updated_at = now()
  where id = p_store_order_id
  returning * into v_order;

  return v_order;
end; $$;

grant execute on function public.start_store_order_payment_pix(uuid, text, text, text, timestamptz) to authenticated;

-- Confirmacao simulada (somente ambiente de desenvolvimento - o guard de
-- NODE_ENV fica na camada de server action, igual ao simulate_order_payment_paid
-- ja usado no checkout de ingresso). O comprador so confirma o proprio pedido.
create or replace function public.simulate_store_order_payment(p_store_order_id uuid, p_payment_method text)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_order public.store_orders%rowtype;
begin
  select * into v_order from public.store_orders where id = p_store_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if v_order.user_id <> v_actor then raise exception 'Sem permissao para confirmar este pedido.'; end if;
  if v_order.status = 'cancelled' then raise exception 'Pedido cancelado nao pode ser confirmado.'; end if;
  if v_order.status = 'confirmed' then return; end if;

  update public.store_orders set status = 'confirmed', payment_status = 'paid', payment_method = coalesce(p_payment_method, payment_method),
    paid_at = now(), confirmed_at = now(), updated_at = now()
  where id = p_store_order_id;
  update public.store_order_items set status = 'confirmed' where store_order_id = p_store_order_id and status = 'reserved';
end; $$;

grant execute on function public.simulate_store_order_payment(uuid, text) to authenticated;

commit;
