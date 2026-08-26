-- Fase 2 Asaas -- PIX sandbox: conecta generatePublicOrderPixAction ao
-- PaymentGatewayProvider real (src/lib/payments/provider.ts, fundacao criada
-- na Fase 1). createPixPayment(...) exige dados do pagador
-- (nome/email/cpf/telefone) para criar/achar o customer na Asaas -- dados que
-- get_order_checkout_snapshot (existente) nao expoe, porque foi desenhada so
-- para o snapshot de exibicao do pedido (nunca precisou de PII do comprador
-- nem de organization_id).
--
-- Esta RPC nova e read-only, dedicada, minima: resolve organization_id +
-- payment_id do pedido + os dados de customer_profiles/auth.users do
-- comprador (orders.user_id) -- nunca de um titular de item (order_items.holder_*),
-- porque quem paga e o COMPRADOR, nao necessariamente quem vai usar o
-- ingresso. Mesmo padrao de autorizacao ja usado por apply_cart_coupon/
-- pop_pending_external_cancellation: dono do pedido ou staff com acesso a
-- organizacao.
begin;

create or replace function public.get_order_payer_details(p_order_id uuid)
returns table(organization_id uuid, payment_id uuid, payer_full_name text, payer_email text, payer_cpf text, payer_phone text)
    language plpgsql security definer
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_payment_id uuid;
begin
  if v_actor is null then raise exception 'Usuario autenticado obrigatorio.'; end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  select p.id into v_payment_id
  from public.payments p
  where p.order_id = p_order_id
  order by p.created_at desc
  limit 1;

  return query
  select
    v_order.organization_id,
    v_payment_id,
    cp.full_name,
    u.email::text,
    cp.cpf,
    cp.phone
  from auth.users u
  left join public.customer_profiles cp on cp.user_id = u.id
  where u.id = v_order.user_id;
end;
$$;

revoke all on function public.get_order_payer_details(uuid) from public, anon;
grant execute on function public.get_order_payer_details(uuid) to authenticated, service_role;

commit;
