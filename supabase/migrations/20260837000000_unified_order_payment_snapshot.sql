-- Causa raiz da regressao "produto some na etapa de Pagamento": a etapa de
-- pagamento do wizard (src/app/inscricao/[eventSlug]/wizard.tsx, bloco
-- `step === 3 && registration`) nunca leu o carrinho de verdade. Ela usa o
-- estado `registration`, populado por `mapOrderToRegistration`, que por sua
-- vez e alimentado por `getOrderSnapshotByOrderId` (src/app/inscricao/
-- actions.ts) -- uma funcao que chama `get_order_checkout_snapshot`, um RPC
-- DELIBERADAMENTE escopado a `item_kind='ticket'` (ver
-- 20260830000000_ticket_snapshot_item_kind_guard.sql: "restando este
-- snapshot ao seu proposito original -- so linhas de ingresso"). Isso e
-- correto pra tela de ingresso pura, mas errado como fonte da etapa de
-- Pagamento de um carrinho MISTO -- daí "Itens no pedido" e a lista
-- mostrarem so ingresso, mesmo com produto no pedido. O "Resumo da compra"
-- lateral tem uma causa raiz PARALELA: usa `summaryValues`, derivado de
-- `checkoutItems` (estado client-side de configuracao de ingresso de ANTES
-- do pedido existir) -- nunca atualizado pelo que acontece dentro do
-- CartStep (produto adicionado/removido, cupom trocado), entao fica
-- congelado no total so-ingresso pra sempre a partir do carrinho em diante.
--
-- Correcao: `get_cart_order_details` (ja a fonte canonica usada pelo
-- CartStep de verdade, ja soma ingresso+produto corretamente em
-- base_amount/discount_amount/final_amount) passa a devolver tambem os
-- campos que so existiam em get_order_checkout_snapshot (order_number,
-- nome do evento, payment com PIX/status, identidade do ingresso -- ticket
-- id/token/participante) -- virando superset estrito das duas fontes. A
-- etapa de Pagamento, a confirmacao final e o resumo lateral passam a ler
-- so daqui (ver mudancas em wizard.tsx/actions.ts), eliminando o calculo
-- paralelo. get_order_checkout_snapshot continua existindo (ainda serve
-- outras chamadas nao relacionadas a este bug), so deixa de ser a fonte da
-- etapa de pagamento do carrinho unificado.
begin;

create or replace function public.get_cart_order_details(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_event public.events%rowtype;
  v_payment public.payments%rowtype; v_items jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  select * into v_event from public.events where id = v_order.event_id;
  select * into v_payment from public.payments where order_id = p_order_id order by created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', oi.id, 'item_kind', oi.item_kind, 'status', oi.status, 'quantity', oi.quantity,
    'item_position', oi.item_position, 'ownership_status', oi.ownership_status,
    'unit_price', oi.unit_price, 'discount_amount', oi.discount_amount, 'final_amount', oi.final_amount,
    'ticket_category_id', oi.ticket_category_id, 'category_name', tc.name, 'batch_name', rb.name,
    'shirt_type', oi.shirt_type, 'shirt_size', oi.shirt_size, 'holder_full_name', oi.holder_full_name,
    'participant_id', oi.participant_id, 'participant_name', part.full_name,
    'ticket_id', t.id, 'ticket_status', t.status, 'ticket_token', t.token,
    'store_item_id', oi.store_item_id, 'store_item_name', si.name,
    'store_item_image_url', (select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1),
    'store_item_variant_id', oi.store_item_variant_id, 'variant_name', siv.name, 'variant_value', siv.value
  ) order by case oi.item_kind when 'ticket' then 0 else 1 end, oi.item_position nulls last, oi.created_at), '[]'::jsonb)
  into v_items
  from public.order_items oi
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.registration_batches rb on rb.id = oi.batch_id
  left join public.participants part on part.id = oi.participant_id
  left join public.tickets t on t.order_item_id = oi.id
  left join public.store_items si on si.id = oi.store_item_id
  left join public.store_item_variants siv on siv.id = oi.store_item_variant_id
  where oi.order_id = p_order_id and oi.status not in ('cancelled','expired','refunded','transferred');

  return jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number, 'order_status', v_order.status,
    'event_id', v_order.event_id, 'event_name', v_event.name,
    'status', v_order.status,
    'base_amount', v_order.base_amount, 'discount_amount', v_order.discount_amount, 'final_amount', v_order.final_amount,
    'applied_coupon_id', v_order.applied_coupon_id,
    'applied_coupon_code', (select code from public.coupons where id = v_order.applied_coupon_id),
    'payment', case when v_payment.id is null then null else jsonb_build_object(
      'payment_id', v_payment.id, 'amount', v_payment.amount, 'discount_amount', v_payment.discount_amount,
      'final_amount', v_payment.final_amount, 'payment_method', v_payment.payment_method, 'payment_status', v_payment.payment_status,
      'pix_code', v_payment.pix_code, 'pix_qrcode', v_payment.pix_qrcode, 'gateway_payment_id', v_payment.gateway_payment_id,
      'expires_at', v_payment.expires_at, 'paid_at', v_payment.paid_at
    ) end,
    'items', v_items
  );
end; $$;

commit;
