-- Feature: repasse de taxa de pagamento ao comprador, configuravel por
-- evento e por metodo (PIX / cartao a vista / cartao parcelado), com 3
-- modos (absorver / repassar / dividir).
--
-- INVESTIGACAO (resumo -- ver relatorio completo dado ao usuario fora desta
-- migration):
--
--   1. Configuracao de metodos de pagamento por evento ja existe em
--      public.event_payment_methods (1 linha por evento_id, RLS
--      "read_only" para authenticated/anon, escrita SOMENTE via RPC
--      SECURITY DEFINER upsert_event_payment_methods -- 20260838000000).
--      Estendida aqui, NAO substituida por tabela paralela.
--
--   2. payments JA tem fee_amount/net_amount (20260895000000) -- mas esse e
--      um conceito DIFERENTE (taxa REAL reportada pelo gateway apos o
--      pagamento, escrita por apply_payment_gateway_status/webhook, pra
--      conciliacao). O que esta migration adiciona e a taxa TEORICA/
--      calculada ANTES da cobranca, com a fatia repassada ao comprador --
--      nomes novos e distintos (payment_fee_*) para nunca confundir os dois.
--
--   3. base_amount/discount_amount/final_amount de orders E payments sao
--      escritos juntos, sempre pelo MESMO ponto: apply_cart_coupon (usado
--      direta ou indiretamente por toda mutacao de carrinho -- add produto,
--      remover item, mudar quantidade, aplicar cupom). finalize_cart_order_
--      payment e o unico outro escritor (so na virada pending->confirmed).
--      generatePublicOrderPixAction (app layer) NUNCA calcula nada -- so lê
--      payment.final_amount (via get_order_checkout_snapshot, que junta
--      payments 1x por pedido, entao already reflete o pedido inteiro) e
--      manda pro Asaas exatamente como esta.
--
--   4. Decisao de modelagem: orders.base_amount/discount_amount/final_amount
--      CONTINUAM significando exatamente o que o proprio comentario da
--      coluna ja diz ("agregado de order_items" -- um conceito comercial,
--      dos ITENS, independente de qual metodo de pagamento for escolhido).
--      A taxa e um conceito de PAGAMENTO (varia por metodo/parcelas e pode
--      mudar sem o carrinho mudar), entao vive em payments, nao em orders:
--        payments.final_amount = orders.final_amount + payment_fee_customer_amount
--      Isso elimina qualquer necessidade de tocar a semantica de
--      orders.discount_amount (taxa nunca vira "desconto negativo") e
--      mantem get_cart_order_details.base_amount/discount_amount/final_amount
--      (o carrinho, Etapa 3) mostrando so o comercial dos itens -- a taxa so
--      aparece a partir do momento em que ha um payment_method definido
--      (Etapa de Pagamento), exatamente como pedido no enunciado ("mostrar
--      na etapa de pagamento").
--
--   5. Cupom (apply_cart_coupon, redefinida em 20260898000000, NAO alterada
--      na formula de desconto aqui) so enxerga order_items -- a taxa nunca
--      passa por ali, entao nunca e elegivel a cupom por construcao (nao
--      existe linha de order_item pra taxa, nunca existira -- restricao
--      explicita do enunciado "nao transformar taxa em order_item falso").
--      A base da taxa (orders.final_amount, JA liquido de desconto de item +
--      cupom) so fica pronta DEPOIS que apply_cart_coupon termina de
--      escrever orders/payments -- por isso o recalculo da taxa roda como
--      ULTIMO passo de apply_cart_coupon (nunca antes), garantindo a ordem
--      determinista pedida: preco original -> desconto proprio do produto ->
--      cupom -> taxa -> total final.
--
--   6. Invalidacao de PIX quando o total muda: mecanismo unico ja existente
--      (apply_cart_coupon zera pix_code/pix_qrcode/gateway_payment_id e
--      marca pending_cancel_provider/pending_cancel_provider_payment_id
--      quando final_amount muda -- 20260843000000/20260898000000; app layer
--      cancela do lado do gateway via cancelPendingExternalCharge/
--      pop_pending_external_cancellation). O helper novo desta migration,
--      _recompute_order_payment_fee, reusa EXATAMENTE o mesmo padrao de
--      CASE WHEN sobre final_amount -- nenhum mecanismo de invalidacao
--      paralelo.
--
--   7. Auditoria cronologica (mesma disciplina que evitou a proxima
--      regressao, ver 20260912000000): get_event_payment_methods_setup e
--      upsert_event_payment_methods vigentes sao as da migration baseline
--      (20260815001914), redefinidas so uma vez depois (20260839000000,
--      so autorizacao). apply_cart_coupon vigente e a 20260898000000.
--      finalize_cart_order_payment vigente e a UNICA definicao, na
--      20260827000000 (nunca redefinida). get_cart_order_details vigente e
--      a desta sessao, 20260912000000. Todas confirmadas por grep antes de
--      escrever esta migration -- nenhuma delas e redefinida a partir de
--      copia desatualizada.
begin;

-- ============================================================
-- 1) event_payment_methods -- estende a tabela existente (nao cria
--    paralela). PIX e cartao a vista ganham fee_mode/fixed/percentage/share
--    completos; cartao parcelado ganha so fee_mode/share aqui (o par
--    fixed/percentage dele VARIA por parcela -- ver tabela nova abaixo,
--    normalizada em linhas em vez de N colunas/booleans).
-- ============================================================
alter table public.event_payment_methods
  add column if not exists pix_fee_mode text not null default 'absorb',
  add column if not exists pix_fee_fixed_amount numeric(10,2) not null default 0,
  add column if not exists pix_fee_percentage numeric(5,2) not null default 0,
  add column if not exists pix_customer_fee_share_percent numeric(5,2) not null default 0,
  add column if not exists credit_card_single_fee_mode text not null default 'absorb',
  add column if not exists credit_card_single_fee_fixed_amount numeric(10,2) not null default 0,
  add column if not exists credit_card_single_fee_percentage numeric(5,2) not null default 0,
  add column if not exists credit_card_single_customer_fee_share_percent numeric(5,2) not null default 0,
  add column if not exists credit_card_installments_fee_mode text not null default 'absorb',
  add column if not exists credit_card_installments_customer_fee_share_percent numeric(5,2) not null default 0;

alter table public.event_payment_methods drop constraint if exists event_payment_methods_pix_fee_mode_check;
alter table public.event_payment_methods add constraint event_payment_methods_pix_fee_mode_check check (pix_fee_mode in ('absorb','pass_through','split'));
alter table public.event_payment_methods drop constraint if exists event_payment_methods_pix_fee_fixed_amount_check;
alter table public.event_payment_methods add constraint event_payment_methods_pix_fee_fixed_amount_check check (pix_fee_fixed_amount >= 0);
alter table public.event_payment_methods drop constraint if exists event_payment_methods_pix_fee_percentage_check;
alter table public.event_payment_methods add constraint event_payment_methods_pix_fee_percentage_check check (pix_fee_percentage >= 0 and pix_fee_percentage <= 100);
alter table public.event_payment_methods drop constraint if exists event_payment_methods_pix_customer_fee_share_percent_check;
alter table public.event_payment_methods add constraint event_payment_methods_pix_customer_fee_share_percent_check check (pix_customer_fee_share_percent >= 0 and pix_customer_fee_share_percent <= 100);

alter table public.event_payment_methods drop constraint if exists event_payment_methods_ccs_fee_mode_check;
alter table public.event_payment_methods add constraint event_payment_methods_ccs_fee_mode_check check (credit_card_single_fee_mode in ('absorb','pass_through','split'));
alter table public.event_payment_methods drop constraint if exists event_payment_methods_ccs_fee_fixed_amount_check;
alter table public.event_payment_methods add constraint event_payment_methods_ccs_fee_fixed_amount_check check (credit_card_single_fee_fixed_amount >= 0);
alter table public.event_payment_methods drop constraint if exists event_payment_methods_ccs_fee_percentage_check;
alter table public.event_payment_methods add constraint event_payment_methods_ccs_fee_percentage_check check (credit_card_single_fee_percentage >= 0 and credit_card_single_fee_percentage <= 100);
alter table public.event_payment_methods drop constraint if exists event_payment_methods_ccs_customer_fee_share_percent_check;
alter table public.event_payment_methods add constraint event_payment_methods_ccs_customer_fee_share_percent_check check (credit_card_single_customer_fee_share_percent >= 0 and credit_card_single_customer_fee_share_percent <= 100);

alter table public.event_payment_methods drop constraint if exists event_payment_methods_cci_fee_mode_check;
alter table public.event_payment_methods add constraint event_payment_methods_cci_fee_mode_check check (credit_card_installments_fee_mode in ('absorb','pass_through','split'));
alter table public.event_payment_methods drop constraint if exists event_payment_methods_cci_customer_fee_share_percent_check;
alter table public.event_payment_methods add constraint event_payment_methods_cci_customer_fee_share_percent_check check (credit_card_installments_customer_fee_share_percent >= 0 and credit_card_installments_customer_fee_share_percent <= 100);

comment on column public.event_payment_methods.pix_fee_mode is 'Tratamento da taxa de pagamento PIX: absorb (organizador assume 100%), pass_through (comprador paga 100%), split (dividido -- ver pix_customer_fee_share_percent). Default absorb: eventos existentes nunca comecam a cobrar taxa automaticamente apos esta migration.';
comment on column public.event_payment_methods.pix_customer_fee_share_percent is 'Só usado quando pix_fee_mode=split: percentual (0-100) da taxa calculada que vai para o comprador; o restante e absorvido pelo organizador.';

-- ============================================================
-- 2) Cartao parcelado -- taxa fixa/percentual POR NUMERO DE PARCELAS,
--    normalizada em linhas (mesmo padrao ja usado no projeto para variacao
--    por opcao -- store_item_variants, registration_batches -- em vez de
--    1 coluna por parcela). fee_mode/share continuam em event_payment_methods
--    (1 so, vale para todas as parcelas -- só o fixed/percentage varia).
--    Parcela sem linha configurada = sem taxa adicional (fixed=0,
--    percentage=0) -- nunca inventa um valor default diferente de zero.
-- ============================================================
create table if not exists public.event_payment_method_installment_fees (
  event_id uuid not null references public.events(id) on delete cascade,
  installments integer not null,
  fixed_fee numeric(10,2) not null default 0,
  percentage_fee numeric(5,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, installments)
);

alter table public.event_payment_method_installment_fees drop constraint if exists event_payment_method_installment_fees_installments_check;
alter table public.event_payment_method_installment_fees add constraint event_payment_method_installment_fees_installments_check check (installments >= 1);
alter table public.event_payment_method_installment_fees drop constraint if exists event_payment_method_installment_fees_fixed_fee_check;
alter table public.event_payment_method_installment_fees add constraint event_payment_method_installment_fees_fixed_fee_check check (fixed_fee >= 0);
alter table public.event_payment_method_installment_fees drop constraint if exists event_payment_method_installment_fees_percentage_fee_check;
alter table public.event_payment_method_installment_fees add constraint event_payment_method_installment_fees_percentage_fee_check check (percentage_fee >= 0 and percentage_fee <= 100);

alter table public.event_payment_method_installment_fees enable row level security;
create policy "event_payment_method_installment_fees_read_only" on public.event_payment_method_installment_fees
  for select to authenticated, anon using (true);

comment on table public.event_payment_method_installment_fees is 'Taxa fixa/percentual de cartao parcelado por numero de parcelas, por evento. Escrita SOMENTE via upsert_event_payment_methods (SECURITY DEFINER) -- RLS aqui e so leitura, mesmo padrao de event_payment_methods.';

-- ============================================================
-- 3) payments -- snapshot da taxa de pagamento efetivamente calculada para
--    ESTE pagamento (metodo/parcelas ja escolhidos). Conceito DIFERENTE de
--    fee_amount/net_amount (20260895000000, taxa REAL pos-pagamento
--    reportada pelo gateway para conciliacao) -- nomes payment_fee_* nunca
--    colidem com esses. final_amount passa a poder ser MAIOR que
--    amount - discount_amount exatamente pela diferenca payment_fee_
--    customer_amount (nunca um "desconto negativo" -- discount_amount
--    continua 100% sobre itens/cupom, intocado).
-- ============================================================
alter table public.payments
  add column if not exists payment_fee_mode text,
  add column if not exists payment_fee_fixed_amount numeric(10,2) not null default 0,
  add column if not exists payment_fee_percentage numeric(5,2) not null default 0,
  add column if not exists payment_fee_customer_share_percent numeric(5,2) not null default 0,
  add column if not exists payment_fee_calculated_amount numeric(10,2) not null default 0,
  add column if not exists payment_fee_customer_amount numeric(10,2) not null default 0,
  add column if not exists payment_fee_organizer_amount numeric(10,2) not null default 0;

alter table public.payments drop constraint if exists payments_payment_fee_mode_check;
alter table public.payments add constraint payments_payment_fee_mode_check check (payment_fee_mode is null or payment_fee_mode in ('absorb','pass_through','split'));
alter table public.payments drop constraint if exists payments_payment_fee_calculated_amount_check;
alter table public.payments add constraint payments_payment_fee_calculated_amount_check check (payment_fee_calculated_amount >= 0);
alter table public.payments drop constraint if exists payments_payment_fee_customer_amount_check;
alter table public.payments add constraint payments_payment_fee_customer_amount_check check (payment_fee_customer_amount >= 0);
alter table public.payments drop constraint if exists payments_payment_fee_organizer_amount_check;
alter table public.payments add constraint payments_payment_fee_organizer_amount_check check (payment_fee_organizer_amount >= 0);

comment on column public.payments.payment_fee_calculated_amount is 'Taxa TEORICA total calculada pela regra configurada (fixed_fee + percentage_fee sobre a base), ANTES de dividir entre comprador/organizador. Distinto de payments.fee_amount (taxa REAL pos-pagamento reportada pelo gateway).';
comment on column public.payments.payment_fee_customer_amount is 'Fatia da taxa calculada efetivamente somada a payments.final_amount e cobrada do comprador. 0 quando payment_fee_mode=absorb.';
comment on column public.payments.payment_fee_organizer_amount is 'Fatia da taxa calculada absorvida pelo organizador (nunca cobrada do comprador). payment_fee_calculated_amount = payment_fee_customer_amount + payment_fee_organizer_amount sempre.';

-- ============================================================
-- 4) compute_payment_fee -- formula canonica unica, pura (sem acesso a
--    tabela), espelhada byte a byte no frontend (src/lib/payments/fee.ts)
--    exatamente como compute_store_item_final_price/computeStoreItemFinalPrice
--    ja fazem para o desconto de produto -- nenhum calculo duplicado com
--    formula diferente em nenhuma tela.
-- ============================================================
create or replace function public.compute_payment_fee(
  p_base_amount numeric, p_fee_mode text, p_customer_fee_share_percent numeric,
  p_fixed_fee numeric, p_percentage_fee numeric
) returns table(calculated_fee numeric, customer_fee numeric, organizer_fee numeric)
language plpgsql immutable as $$
declare
  v_base numeric := greatest(coalesce(p_base_amount, 0), 0);
  v_calculated numeric;
  v_customer numeric;
  v_share numeric := least(greatest(coalesce(p_customer_fee_share_percent, 0), 0), 100);
begin
  v_calculated := greatest(round(coalesce(p_fixed_fee, 0) + v_base * coalesce(p_percentage_fee, 0) / 100.0, 2), 0);
  v_customer := case
    when v_base <= 0 then 0
    when p_fee_mode = 'pass_through' then v_calculated
    when p_fee_mode = 'split' then round(v_calculated * v_share / 100.0, 2)
    else 0
  end;
  return query select v_calculated, v_customer, round(v_calculated - v_customer, 2);
end; $$;

-- ============================================================
-- 5) resolve_event_payment_fee_config -- unico ponto que decide QUAL linha
--    de configuracao vale para (evento, metodo, parcelas). payment_method
--    aqui e sempre o valor JA gravado em payments.payment_method
--    ('pix'|'credit_card'|'cash'|'courtesy' -- mesmo dominio de
--    payments_method_check); parcelas <=1 usa a config de cartao a vista,
--    >1 usa cartao parcelado + a linha da tabela de parcelas (parcela sem
--    linha configurada = fixed/percentage 0, nunca inventa valor).
-- ============================================================
create or replace function public.resolve_event_payment_fee_config(
  p_event_id uuid, p_payment_method text, p_installments integer default 1
) returns table(fee_mode text, customer_fee_share_percent numeric, fixed_fee numeric, percentage_fee numeric)
language plpgsql security definer stable set search_path to 'public', 'pg_temp' as $$
declare
  v_method text := lower(trim(coalesce(p_payment_method, '')));
  v_epm public.event_payment_methods%rowtype;
  v_installment public.event_payment_method_installment_fees%rowtype;
begin
  select * into v_epm from public.event_payment_methods where event_id = p_event_id;

  if v_method = 'pix' then
    return query select coalesce(v_epm.pix_fee_mode, 'absorb'), coalesce(v_epm.pix_customer_fee_share_percent, 0),
      coalesce(v_epm.pix_fee_fixed_amount, 0), coalesce(v_epm.pix_fee_percentage, 0);
    return;
  end if;

  if v_method = 'credit_card' and coalesce(p_installments, 1) <= 1 then
    return query select coalesce(v_epm.credit_card_single_fee_mode, 'absorb'), coalesce(v_epm.credit_card_single_customer_fee_share_percent, 0),
      coalesce(v_epm.credit_card_single_fee_fixed_amount, 0), coalesce(v_epm.credit_card_single_fee_percentage, 0);
    return;
  end if;

  if v_method = 'credit_card' then
    select * into v_installment from public.event_payment_method_installment_fees
      where event_id = p_event_id and installments = p_installments;
    return query select coalesce(v_epm.credit_card_installments_fee_mode, 'absorb'), coalesce(v_epm.credit_card_installments_customer_fee_share_percent, 0),
      coalesce(v_installment.fixed_fee, 0), coalesce(v_installment.percentage_fee, 0);
    return;
  end if;

  -- cash/courtesy/desconhecido: nunca ha taxa de gateway a repassar.
  return query select 'absorb'::text, 0::numeric, 0::numeric, 0::numeric;
end; $$;

revoke all on function public.compute_payment_fee(numeric, text, numeric, numeric, numeric) from public, anon;
grant execute on function public.compute_payment_fee(numeric, text, numeric, numeric, numeric) to authenticated, service_role;
revoke all on function public.resolve_event_payment_fee_config(uuid, text, integer) from public, anon;
grant execute on function public.resolve_event_payment_fee_config(uuid, text, integer) to authenticated, service_role;

-- ============================================================
-- 6) _recompute_order_payment_fee -- unico escritor da taxa em payments.
--    Le orders.final_amount (JA liquido de desconto de item + cupom, escrito
--    por apply_cart_coupon logo antes de chamar este helper) como base,
--    resolve a config vigente do metodo/parcelas JA gravados no payment
--    pendente, e grava o snapshot completo + o novo final_amount
--    (base + fatia do comprador). Reusa EXATAMENTE o mesmo padrao de
--    invalidacao de PIX ja usado por apply_cart_coupon (CASE WHEN sobre
--    final_amount antigo x novo) -- nenhum mecanismo paralelo. Pedido sem
--    payment pendente, ou payment sem payment_method ainda escolhido, ou
--    pedido zerado (cortesia/cupom 100%): sem taxa (nunca inventa cobranca
--    sobre um pedido gratuito).
-- ============================================================
create or replace function public._recompute_order_payment_fee(p_order_id uuid)
returns void language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_config record;
  v_fee record;
  v_new_final numeric;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then return; end if;

  select * into v_payment from public.payments
    where order_id = p_order_id and payment_status = 'pending'
    order by created_at desc limit 1 for update;
  if not found then return; end if;

  if v_payment.payment_method is null or lower(trim(v_payment.payment_method)) = 'courtesy' or v_order.final_amount <= 0 then
    v_new_final := v_order.final_amount;
    update public.payments set
      payment_fee_mode = null, payment_fee_fixed_amount = 0, payment_fee_percentage = 0,
      payment_fee_customer_share_percent = 0, payment_fee_calculated_amount = 0,
      payment_fee_customer_amount = 0, payment_fee_organizer_amount = 0,
      amount = v_order.base_amount, discount_amount = v_order.discount_amount,
      final_amount = v_new_final, updated_at = now(),
      pix_code = case when final_amount is distinct from v_new_final then null else pix_code end,
      pix_qrcode = case when final_amount is distinct from v_new_final then null else pix_qrcode end,
      gateway_payment_id = case when final_amount is distinct from v_new_final then null else gateway_payment_id end,
      pending_cancel_provider = case when final_amount is distinct from v_new_final and gateway_payment_id is not null and provider is not null then provider else pending_cancel_provider end,
      pending_cancel_provider_payment_id = case when final_amount is distinct from v_new_final and gateway_payment_id is not null and provider is not null then gateway_payment_id else pending_cancel_provider_payment_id end
    where id = v_payment.id;
    return;
  end if;

  select * into v_config from public.resolve_event_payment_fee_config(v_order.event_id, v_payment.payment_method, coalesce(v_payment.installments, 1));
  select * into v_fee from public.compute_payment_fee(v_order.final_amount, v_config.fee_mode, v_config.customer_fee_share_percent, v_config.fixed_fee, v_config.percentage_fee);

  v_new_final := round(v_order.final_amount + v_fee.customer_fee, 2);

  update public.payments set
    payment_fee_mode = v_config.fee_mode,
    payment_fee_fixed_amount = v_config.fixed_fee,
    payment_fee_percentage = v_config.percentage_fee,
    payment_fee_customer_share_percent = v_config.customer_fee_share_percent,
    payment_fee_calculated_amount = v_fee.calculated_fee,
    payment_fee_customer_amount = v_fee.customer_fee,
    payment_fee_organizer_amount = v_fee.organizer_fee,
    amount = v_order.base_amount,
    discount_amount = v_order.discount_amount,
    final_amount = v_new_final,
    updated_at = now(),
    pix_code = case when final_amount is distinct from v_new_final then null else pix_code end,
    pix_qrcode = case when final_amount is distinct from v_new_final then null else pix_qrcode end,
    gateway_payment_id = case when final_amount is distinct from v_new_final then null else gateway_payment_id end,
    pending_cancel_provider = case when final_amount is distinct from v_new_final and gateway_payment_id is not null and provider is not null then provider else pending_cancel_provider end,
    pending_cancel_provider_payment_id = case when final_amount is distinct from v_new_final and gateway_payment_id is not null and provider is not null then gateway_payment_id else pending_cancel_provider_payment_id end
  where id = v_payment.id;
end; $$;

revoke all on function public._recompute_order_payment_fee(uuid) from public, anon, authenticated;
grant execute on function public._recompute_order_payment_fee(uuid) to service_role;

-- ============================================================
-- 7) apply_cart_coupon -- redefinida a partir da versao VIGENTE
--    (20260898000000, confirmada por grep como a ultima antes desta
--    migration). UNICA mudanca: chama _recompute_order_payment_fee como
--    ULTIMO passo, depois que orders/payments ja tem o subtotal liquido de
--    desconto de item + cupom -- garante a base da taxa sempre correta e
--    reusa o mesmo ponto de invalidacao de PIX pra qualquer mutacao de
--    carrinho (add produto, remover, mudar quantidade, aplicar/remover
--    cupom -- todas passam por aqui). Formula de cupom em si: intocada.
-- ============================================================
create or replace function public.apply_cart_coupon(p_order_id uuid, p_coupon_code text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_coupon public.coupons%rowtype;
  v_code text := upper(trim(coalesce(p_coupon_code, '')));
  v_item record;
  v_line_subtotal numeric;
  v_eligible_subtotal numeric := 0;
  v_total_subtotal numeric := 0;
  v_total_discount numeric := 0;
  v_allocated numeric := 0;
  v_item_discount numeric;
  v_eligible_count integer := 0;
  v_now timestamptz := now();
  v_previous_coupon_id uuid;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;
  if v_order.status not in ('pending') then
    raise exception 'Pedido nao esta mais no carrinho (status atual: %).', v_order.status;
  end if;

  v_previous_coupon_id := v_order.applied_coupon_id;

  if v_code = '' then
    v_coupon.id := null;
  else
    select * into v_coupon from public.coupons where organization_id = v_order.organization_id and code = v_code for update;
    if not found then raise exception using errcode='P0001', message='COUPON_INVALID', detail=jsonb_build_object('code','COUPON_INVALID','message','Codigo de cupom invalido para esta organizacao.')::text; end if;
    if not v_coupon.is_active then raise exception using errcode='P0001', message='COUPON_INACTIVE', detail=jsonb_build_object('code','COUPON_INACTIVE','message','Cupom inativo.')::text; end if;
    if v_coupon.valid_from is not null and v_now < v_coupon.valid_from then raise exception using errcode='P0001', message='COUPON_NOT_YET_VALID', detail=jsonb_build_object('code','COUPON_NOT_YET_VALID','message','Cupom ainda nao esta vigente.')::text; end if;
    if v_coupon.valid_until is not null and v_now > v_coupon.valid_until then raise exception using errcode='P0001', message='COUPON_EXPIRED', detail=jsonb_build_object('code','COUPON_EXPIRED','message','Cupom expirado.')::text; end if;
    if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses
      and v_previous_coupon_id is distinct from v_coupon.id then
      raise exception using errcode='P0001', message='COUPON_USES_EXHAUSTED', detail=jsonb_build_object('code','COUPON_USES_EXHAUSTED','message','Limite de usos do cupom atingido.')::text;
    end if;
  end if;

  for v_item in
    select id, item_kind, event_id, ticket_category_id, store_item_id, unit_price, quantity
    from public.order_items
    where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')
    order by item_position nulls last, created_at, id
    for update
  loop
    v_line_subtotal := round(v_item.unit_price * coalesce(v_item.quantity, 1), 2);
    v_total_subtotal := v_total_subtotal + v_line_subtotal;
    if v_coupon.id is not null and public.is_order_item_eligible_for_coupon(v_coupon.id, v_item.item_kind, v_item.event_id, v_item.ticket_category_id, v_item.store_item_id) then
      v_eligible_subtotal := v_eligible_subtotal + v_line_subtotal;
      v_eligible_count := v_eligible_count + 1;
    end if;
  end loop;

  if v_coupon.id is not null and v_eligible_count = 0 then
    raise exception using errcode='P0001', message='COUPON_NO_ELIGIBLE_ITEMS', detail=jsonb_build_object('code','COUPON_NO_ELIGIBLE_ITEMS','message','Nenhum item do carrinho e elegivel para este cupom.')::text;
  end if;

  if v_coupon.id is not null then
    if v_coupon.discount_type = 'percentage' then
      v_total_discount := round(v_eligible_subtotal * v_coupon.discount_value / 100.0, 2);
    else
      v_total_discount := least(v_coupon.discount_value, v_eligible_subtotal);
    end if;
    v_total_discount := greatest(0, round(v_total_discount, 2));
  end if;

  delete from public.order_item_discounts where order_item_id in (select id from public.order_items where order_id = p_order_id);
  v_allocated := 0;
  for v_item in
    select id, item_kind, event_id, ticket_category_id, store_item_id, unit_price, quantity,
      row_number() over (order by item_position nulls last, created_at, id) as rn,
      count(*) over () as total_rows
    from public.order_items
    where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')
  loop
    v_line_subtotal := round(v_item.unit_price * coalesce(v_item.quantity, 1), 2);
    v_item_discount := 0;
    if v_coupon.id is not null and v_eligible_subtotal > 0
      and public.is_order_item_eligible_for_coupon(v_coupon.id, v_item.item_kind, v_item.event_id, v_item.ticket_category_id, v_item.store_item_id) then
      if v_item.rn = v_item.total_rows then
        v_item_discount := v_total_discount - v_allocated;
      else
        v_item_discount := round(v_line_subtotal / v_eligible_subtotal * v_total_discount, 2);
      end if;
      v_item_discount := greatest(0, least(v_item_discount, v_line_subtotal));
      v_allocated := v_allocated + v_item_discount;
    end if;

    update public.order_items
    set discount_amount = v_item_discount, final_amount = round(v_line_subtotal - v_item_discount, 2), updated_at = now()
    where id = v_item.id;

    if v_item_discount > 0 then
      insert into public.order_item_discounts(order_item_id, coupon_id, coupon_code, discount_type, discount_value, base_amount, discount_amount, final_amount)
      values (v_item.id, v_coupon.id, v_coupon.code, v_coupon.discount_type, v_coupon.discount_value, v_line_subtotal, v_item_discount, round(v_line_subtotal - v_item_discount, 2));
    end if;
  end loop;

  if v_previous_coupon_id is not null and v_previous_coupon_id is distinct from v_coupon.id then
    update public.coupons set used_count = greatest(used_count - 1, 0), updated_at = now() where id = v_previous_coupon_id;
  end if;
  if v_coupon.id is not null and v_previous_coupon_id is distinct from v_coupon.id then
    update public.coupons set used_count = used_count + 1, updated_at = now() where id = v_coupon.id;
  end if;

  update public.orders set applied_coupon_id = v_coupon.id, base_amount = v_total_subtotal,
    discount_amount = v_allocated, final_amount = round(v_total_subtotal - v_allocated, 2)
  where id = p_order_id;

  update public.payments set amount = v_total_subtotal, discount_amount = v_allocated,
    final_amount = round(v_total_subtotal - v_allocated, 2), updated_at = now(),
    pix_code = case when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) then null else pix_code end,
    pix_qrcode = case when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) then null else pix_qrcode end,
    gateway_payment_id = case when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) then null else gateway_payment_id end,
    pending_cancel_provider = case
      when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) and gateway_payment_id is not null and provider is not null
        then provider
      else pending_cancel_provider
    end,
    pending_cancel_provider_payment_id = case
      when final_amount is distinct from round(v_total_subtotal - v_allocated, 2) and gateway_payment_id is not null and provider is not null
        then gateway_payment_id
      else pending_cancel_provider_payment_id
    end
  where order_id = p_order_id and payment_status = 'pending';

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_coupon_applied', 'orders', p_order_id, v_order.event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'coupon_id', v_coupon.id, 'coupon_code', nullif(v_code,''),
    'eligible_subtotal', v_eligible_subtotal, 'total_subtotal', v_total_subtotal, 'discount_amount', v_allocated));

  -- Taxa de pagamento: SEMPRE por ultimo, com orders/payments ja liquidos de
  -- desconto de item + cupom -- nunca incide sobre subtotal bruto, nunca e
  -- elegivel a cupom (nao existe order_item pra ela).
  perform public._recompute_order_payment_fee(p_order_id);

  select jsonb_build_object(
    'order_id', p_order_id, 'coupon_id', v_coupon.id, 'coupon_code', nullif(v_code,''),
    'base_amount', v_total_subtotal, 'eligible_subtotal', v_eligible_subtotal,
    'discount_amount', v_allocated, 'final_amount', round(v_total_subtotal - v_allocated, 2)
  ) into v_result;
  return v_result;
end; $$;

-- ============================================================
-- 8) finalize_cart_order_payment -- unica definicao ate aqui (20260827000000,
--    nunca redefinida). Ganha p_installments (nova, default 1 -- nenhum call
--    site precisa mudar OBRIGATORIAMENTE, mas actions.ts e atualizada para
--    passar o numero real de parcelas quando o metodo for cartao parcelado)
--    e recalcula a taxa para o metodo JA escolhido antes de decidir pago x
--    pendente -- corrige de quebra um gap encontrado na auditoria: esta RPC
--    gravava payment_method = trim(p_payment_method) SEM validar contra
--    payments_method_check, e o frontend podia mandar 'credit_card_single'/
--    'credit_card_installments' (granularidade so de UI) direto pra ca --
--    violaria a constraint. Corrigido validando contra o mesmo dominio ja
--    usado pela tabela (pix/credit_card/cash/courtesy); a colagem
--    single/installments -> credit_card continua feita no MESMO helper
--    toDbPaymentMethod ja usado pelos outros dois call sites de checkout
--    (actions.ts), agora tambem usado por finalizeCartOrderAction.
-- ============================================================
drop function if exists public.finalize_cart_order_payment(uuid, text);

create or replace function public.finalize_cart_order_payment(p_order_id uuid, p_payment_method text, p_installments integer default 1)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_payment public.payments%rowtype;
  v_status text; v_item record; v_method text := trim(coalesce(p_payment_method, ''));
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido ja foi finalizado.'; end if;
  if not exists(select 1 from public.order_items where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')) then
    raise exception 'Carrinho vazio.';
  end if;
  if lower(v_method) not in ('pix','credit_card','cash','courtesy') then
    raise exception 'Forma de pagamento invalida.';
  end if;

  select * into v_payment from public.payments where order_id = p_order_id order by created_at desc limit 1 for update;
  if not found then raise exception 'Pagamento nao encontrado para o pedido.'; end if;

  update public.payments set
    payment_method = lower(v_method),
    installments = case when lower(v_method) = 'credit_card' then greatest(coalesce(p_installments, 1), 1) else null end,
    updated_at = now()
  where id = v_payment.id;

  perform public._recompute_order_payment_fee(p_order_id);

  select * into v_payment from public.payments where id = v_payment.id;

  v_status := case when lower(v_method) = 'courtesy' or v_payment.final_amount <= 0 then 'paid' else 'pending' end;

  update public.payments set payment_status = v_status,
    paid_at = case when v_status = 'paid' then coalesce(paid_at, now()) end, updated_at = now()
  where id = v_payment.id;

  update public.orders set status = case when v_status = 'paid' then 'confirmed' else 'pending' end,
    confirmed_at = case when v_status = 'paid' then coalesce(confirmed_at, now()) else confirmed_at end
  where id = p_order_id;

  if v_status = 'paid' then
    for v_item in select id from public.order_items where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred') loop
      perform public.confirm_order_item_and_issue_ticket(v_item.id);
    end loop;
  end if;

  return jsonb_build_object('order_id', p_order_id, 'payment_status', v_status, 'final_amount', v_payment.final_amount);
end; $$;

revoke all on function public.apply_cart_coupon(uuid,text) from public,anon;
grant execute on function public.apply_cart_coupon(uuid,text) to authenticated,service_role;
revoke all on function public.finalize_cart_order_payment(uuid,text,integer) from public,anon;
grant execute on function public.finalize_cart_order_payment(uuid,text,integer) to authenticated,service_role;

-- ============================================================
-- 9) get_cart_order_details -- redefinida a partir da versao VIGENTE
--    (20260912000000, desta mesma sessao -- confirmada por grep como a
--    ultima). UNICA mudanca: bloco 'payment' ganha os campos novos de taxa,
--    pra Etapa de Pagamento mostrar Subtotal/Desconto/Taxa/Total a partir
--    do snapshot canonico, sem calcular nada em paralelo no frontend.
-- ============================================================
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
    'unit_price', oi.unit_price, 'product_base_unit_price', oi.product_base_unit_price, 'discount_amount', oi.discount_amount, 'final_amount', oi.final_amount,
    'ticket_category_id', oi.ticket_category_id, 'category_name', tc.name, 'batch_name', rb.name,
    'shirt_type', oi.shirt_type, 'shirt_size', oi.shirt_size, 'pricing_gender', oi.pricing_gender,
    'holder_full_name', oi.holder_full_name,
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
      'expires_at', v_payment.expires_at, 'paid_at', v_payment.paid_at,
      'payment_fee_mode', v_payment.payment_fee_mode,
      'payment_fee_calculated_amount', v_payment.payment_fee_calculated_amount,
      'payment_fee_customer_amount', v_payment.payment_fee_customer_amount,
      'payment_fee_organizer_amount', v_payment.payment_fee_organizer_amount
    ) end,
    'items', v_items
  );
end; $$;

-- ============================================================
-- 10) get_event_payment_methods_setup -- estende o retorno (arity muda,
--     precisa DROP explicito -- mesma disciplina ja usada em
--     20260895000000 pra nao deixar um overload velho ao lado). Devolve a
--     config completa de taxa por metodo + o cronograma de parcelas
--     (installment_fees, jsonb -- 1 chamada so, mesmo padrao ja usado por
--     list_store_items_for_event agregando variantes).
-- ============================================================
drop function if exists public.get_event_payment_methods_setup(uuid);

create or replace function public.get_event_payment_methods_setup(p_event_id uuid)
returns table(
  event_id uuid, pix_enabled boolean, credit_card_single_enabled boolean, credit_card_installments_enabled boolean,
  pix_fee_mode text, pix_fee_fixed_amount numeric, pix_fee_percentage numeric, pix_customer_fee_share_percent numeric,
  credit_card_single_fee_mode text, credit_card_single_fee_fixed_amount numeric, credit_card_single_fee_percentage numeric, credit_card_single_customer_fee_share_percent numeric,
  credit_card_installments_fee_mode text, credit_card_installments_customer_fee_share_percent numeric,
  installment_fees jsonb
)
    language sql stable security definer
    set search_path to 'public', 'pg_temp'
    as $$
  select
    e.id as event_id,
    coalesce(epm.pix_enabled, true), coalesce(epm.credit_card_single_enabled, true), coalesce(epm.credit_card_installments_enabled, true),
    coalesce(epm.pix_fee_mode, 'absorb'), coalesce(epm.pix_fee_fixed_amount, 0), coalesce(epm.pix_fee_percentage, 0), coalesce(epm.pix_customer_fee_share_percent, 0),
    coalesce(epm.credit_card_single_fee_mode, 'absorb'), coalesce(epm.credit_card_single_fee_fixed_amount, 0), coalesce(epm.credit_card_single_fee_percentage, 0), coalesce(epm.credit_card_single_customer_fee_share_percent, 0),
    coalesce(epm.credit_card_installments_fee_mode, 'absorb'), coalesce(epm.credit_card_installments_customer_fee_share_percent, 0),
    coalesce((
      select jsonb_agg(jsonb_build_object('installments', f.installments, 'fixed_fee', f.fixed_fee, 'percentage_fee', f.percentage_fee) order by f.installments)
      from public.event_payment_method_installment_fees f
      where f.event_id = e.id
    ), '[]'::jsonb)
  from public.events e
  left join public.event_payment_methods epm on epm.event_id = e.id
  where e.id = p_event_id;
$$;

revoke all on function public.get_event_payment_methods_setup(uuid) from public;
grant execute on function public.get_event_payment_methods_setup(uuid) to anon, authenticated, service_role;

-- ============================================================
-- 11) upsert_event_payment_methods -- ganha os parametros novos de taxa
--     (arity muda, DROP explicito da assinatura antiga) + p_installment_fees
--     (jsonb, substitui o cronograma inteiro de parcelas do evento --
--     mesmo padrao "replace completo" ja usado por upsert_registration_
--     batch_addons/registration_batch_addons: delete + insert, nunca merge
--     parcial). Autorizacao: MESMO padrao ja usado pela versao vigente
--     (20260839000000) -- auth.uid() + current_user_has_permission
--     ('events.edit') + user_can_access_organization, nada novo inventado.
-- ============================================================
drop function if exists public.upsert_event_payment_methods(uuid, boolean, boolean, boolean);

create or replace function public.upsert_event_payment_methods(
  p_event_id uuid,
  p_pix_enabled boolean default true,
  p_credit_card_single_enabled boolean default true,
  p_credit_card_installments_enabled boolean default true,
  p_pix_fee_mode text default 'absorb',
  p_pix_fee_fixed_amount numeric default 0,
  p_pix_fee_percentage numeric default 0,
  p_pix_customer_fee_share_percent numeric default 0,
  p_credit_card_single_fee_mode text default 'absorb',
  p_credit_card_single_fee_fixed_amount numeric default 0,
  p_credit_card_single_fee_percentage numeric default 0,
  p_credit_card_single_customer_fee_share_percent numeric default 0,
  p_credit_card_installments_fee_mode text default 'absorb',
  p_credit_card_installments_customer_fee_share_percent numeric default 0,
  p_installment_fees jsonb default '[]'::jsonb
) returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_org uuid;
  v_row jsonb;
  v_installments integer;
begin
  if p_event_id is null then
    raise exception 'Evento invalido.';
  end if;

  if auth.uid() is null or not public.current_user_has_permission('events.edit') then
    raise exception 'Sem permissao para configurar o evento.';
  end if;

  select organization_id into v_org from public.events where id = p_event_id;
  if v_org is null or not public.user_can_access_organization(auth.uid(), v_org) then
    raise exception 'Evento invalido ou sem acesso.';
  end if;

  if not coalesce(p_pix_enabled, false)
     and not coalesce(p_credit_card_single_enabled, false)
     and not coalesce(p_credit_card_installments_enabled, false) then
    raise exception 'Selecione pelo menos uma forma de pagamento.';
  end if;

  if coalesce(p_pix_fee_mode, 'absorb') not in ('absorb','pass_through','split')
     or coalesce(p_credit_card_single_fee_mode, 'absorb') not in ('absorb','pass_through','split')
     or coalesce(p_credit_card_installments_fee_mode, 'absorb') not in ('absorb','pass_through','split') then
    raise exception 'Modo de taxa invalido.';
  end if;

  insert into public.event_payment_methods (
    event_id, pix_enabled, credit_card_single_enabled, credit_card_installments_enabled,
    pix_fee_mode, pix_fee_fixed_amount, pix_fee_percentage, pix_customer_fee_share_percent,
    credit_card_single_fee_mode, credit_card_single_fee_fixed_amount, credit_card_single_fee_percentage, credit_card_single_customer_fee_share_percent,
    credit_card_installments_fee_mode, credit_card_installments_customer_fee_share_percent,
    created_at, updated_at
  )
  values (
    p_event_id, coalesce(p_pix_enabled, true), coalesce(p_credit_card_single_enabled, true),
    coalesce(p_credit_card_installments_enabled, true),
    coalesce(p_pix_fee_mode, 'absorb'), coalesce(p_pix_fee_fixed_amount, 0), coalesce(p_pix_fee_percentage, 0), coalesce(p_pix_customer_fee_share_percent, 0),
    coalesce(p_credit_card_single_fee_mode, 'absorb'), coalesce(p_credit_card_single_fee_fixed_amount, 0), coalesce(p_credit_card_single_fee_percentage, 0), coalesce(p_credit_card_single_customer_fee_share_percent, 0),
    coalesce(p_credit_card_installments_fee_mode, 'absorb'), coalesce(p_credit_card_installments_customer_fee_share_percent, 0),
    now(), now()
  )
  on conflict (event_id) do update set
    pix_enabled = excluded.pix_enabled,
    credit_card_single_enabled = excluded.credit_card_single_enabled,
    credit_card_installments_enabled = excluded.credit_card_installments_enabled,
    pix_fee_mode = excluded.pix_fee_mode,
    pix_fee_fixed_amount = excluded.pix_fee_fixed_amount,
    pix_fee_percentage = excluded.pix_fee_percentage,
    pix_customer_fee_share_percent = excluded.pix_customer_fee_share_percent,
    credit_card_single_fee_mode = excluded.credit_card_single_fee_mode,
    credit_card_single_fee_fixed_amount = excluded.credit_card_single_fee_fixed_amount,
    credit_card_single_fee_percentage = excluded.credit_card_single_fee_percentage,
    credit_card_single_customer_fee_share_percent = excluded.credit_card_single_customer_fee_share_percent,
    credit_card_installments_fee_mode = excluded.credit_card_installments_fee_mode,
    credit_card_installments_customer_fee_share_percent = excluded.credit_card_installments_customer_fee_share_percent,
    updated_at = now();

  delete from public.event_payment_method_installment_fees where event_id = p_event_id;
  if jsonb_typeof(p_installment_fees) = 'array' then
    for v_row in select * from jsonb_array_elements(p_installment_fees)
    loop
      v_installments := (v_row ->> 'installments')::integer;
      if v_installments is not null and v_installments >= 1 then
        insert into public.event_payment_method_installment_fees (event_id, installments, fixed_fee, percentage_fee, updated_at)
        values (p_event_id, v_installments, coalesce((v_row ->> 'fixed_fee')::numeric, 0), coalesce((v_row ->> 'percentage_fee')::numeric, 0), now())
        on conflict (event_id, installments) do update set
          fixed_fee = excluded.fixed_fee, percentage_fee = excluded.percentage_fee, updated_at = now();
      end if;
    end loop;
  end if;
end;
$$;

revoke all on function public.upsert_event_payment_methods(uuid, boolean, boolean, boolean, text, numeric, numeric, numeric, text, numeric, numeric, numeric, text, numeric, jsonb) from public;
grant execute on function public.upsert_event_payment_methods(uuid, boolean, boolean, boolean, text, numeric, numeric, numeric, text, numeric, numeric, numeric, text, numeric, jsonb) to authenticated, service_role;

commit;
