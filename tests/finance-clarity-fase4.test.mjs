import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canRegisterOffGatewayPayment } from "../src/lib/finance/settlement-nature.ts";
import {
  canShowOffGatewayRegularizeCta,
  financeSalesStatusFilterLabel,
  offGatewayExpectedAmount,
  presentFinancePayment,
} from "../src/lib/finance/payment-presentation.ts";
import { humanizeOffGatewayError } from "../src/lib/finance/off-gateway-errors.ts";
import { adminRefundVisualLabel } from "../src/lib/payments/admin-refund-eligibility.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function pixGateway(overrides = {}) {
  return {
    payment_status: "paid",
    payment_method: "pix",
    paid_at: "2026-09-22T23:40:00.000Z",
    final_amount: 176.99,
    amount: 175,
    discount_amount: 0,
    payment_fee_customer_amount: 1.99,
    settlement_nature: "gateway",
    provider: "asaas",
    gateway_payment_id: "pay_x",
    gateway_account_key: "asaas-conta-live-01",
    gateway_environment: "production",
    ...overrides,
  };
}

function cardGateway(overrides = {}) {
  return pixGateway({ payment_method: "credit_card", final_amount: 180, ...overrides });
}

test("A. PIX pago: entrou dinheiro, Pago, Asaas", () => {
  const view = presentFinancePayment(pixGateway());
  assert.equal(view.badge, "paid");
  assert.equal(view.statusLabel, "Pago");
  assert.equal(view.moneyEntered, true);
  assert.equal(view.isRevenue, true);
  assert.equal(view.displayAmount, 176.99);
  assert.match(view.methodLabel, /PIX/);
  assert.match(view.methodLabel, /Asaas/);
  assert.equal(view.whenIso, "2026-09-22T23:40:00.000Z");
});

test("B. cartão pago: entrou dinheiro, Pago, Asaas", () => {
  const view = presentFinancePayment(cardGateway());
  assert.equal(view.badge, "paid");
  assert.equal(view.statusLabel, "Pago");
  assert.equal(view.moneyEntered, true);
  assert.match(view.methodLabel, /Cartão/);
});

test("C. PIX expirado: não entrou dinheiro, EXPIRADO", () => {
  const view = presentFinancePayment(pixGateway({
    payment_status: "expired",
    paid_at: null,
    final_amount: 89.49,
  }));
  assert.equal(view.badge, "expired");
  assert.equal(view.statusLabel, "Expirado");
  assert.equal(view.moneyEntered, false);
  assert.equal(view.isRevenue, false);
});

test("D. pending: não entrou dinheiro", () => {
  const view = presentFinancePayment(pixGateway({
    payment_status: "pending",
    paid_at: null,
  }));
  assert.equal(view.badge, "pending");
  assert.equal(view.statusLabel, "Pendente");
  assert.equal(view.moneyEntered, false);
});

test("E. cortesia: não é receita e não mostra R$ 0 como entrada", () => {
  const view = presentFinancePayment({
    payment_status: "paid",
    payment_method: "courtesy",
    settlement_nature: "courtesy",
    final_amount: 0,
    amount: 200,
    discount_amount: 200,
    paid_at: "2026-09-20T12:00:00.000Z",
  });
  assert.equal(view.badge, "courtesy");
  assert.equal(view.statusLabel, "Cortesia");
  assert.equal(view.moneyEntered, false);
  assert.equal(view.isRevenue, false);
  assert.equal(view.displayAmount, null);
  assert.equal(view.amountCaption, "não é receita");
});

test("F. cupom 100%: não é receita", () => {
  const view = presentFinancePayment({
    payment_status: "paid",
    payment_method: "pix",
    settlement_nature: "coupon_zero",
    final_amount: 0,
    amount: 175,
    discount_amount: 175,
  });
  assert.equal(view.badge, "coupon_zero");
  assert.equal(view.statusLabel, "Cupom 100%");
  assert.equal(view.moneyEntered, false);
  assert.equal(view.displayAmount, null);
});

test("G. off_gateway: natureza fora do gateway e valor recebido", () => {
  const view = presentFinancePayment({
    payment_status: "paid",
    payment_method: "courtesy",
    settlement_nature: "courtesy",
    off_gateway_method: "pix",
    off_gateway_amount: 215,
    off_gateway_recorded_at: "2026-09-20T12:00:00.000Z",
    off_gateway_received_at: "2026-09-18T14:30:00.000Z",
    final_amount: 0,
  });
  assert.equal(view.badge, "off_gateway");
  assert.equal(view.statusLabel, "Fora do gateway");
  assert.equal(view.moneyEntered, true);
  assert.equal(view.displayAmount, 215);
  assert.match(view.methodLabel, /Fora do gateway/);
  assert.equal(view.whenIso, "2026-09-18T14:30:00.000Z");
});

test("H. CTA elegível: legado pago sem gateway", () => {
  const payment = {
    payment_status: "paid",
    payment_method: "pix",
    final_amount: 175,
    amount: 175,
    price_origin: "legacy_known",
  };
  assert.equal(canRegisterOffGatewayPayment(payment).allowed, true);
  const cta = canShowOffGatewayRegularizeCta({ payment, hasPermission: true, surface: "order" });
  assert.equal(cta.show, true);
  assert.equal(cta.replace, false);
});

test("I. CTA não aparece em PIX pago no gateway", () => {
  const cta = canShowOffGatewayRegularizeCta({
    payment: pixGateway(),
    hasPermission: true,
    surface: "order",
  });
  assert.equal(cta.show, false);
  assert.match(cta.reason ?? "", /gateway/i);
});

test("J. CTA não aparece em cortesia na ficha do pedido", () => {
  const payment = {
    payment_status: "paid",
    payment_method: "courtesy",
    settlement_nature: "courtesy",
    final_amount: 0,
  };
  assert.equal(canRegisterOffGatewayPayment(payment).allowed, true);
  const orderCta = canShowOffGatewayRegularizeCta({ payment, hasPermission: true, surface: "order" });
  assert.equal(orderCta.show, false);
  const paymentCta = canShowOffGatewayRegularizeCta({ payment, hasPermission: true, surface: "payment" });
  assert.equal(paymentCta.show, true);
});

test("K. CTA não aparece em cupom 100%", () => {
  const payment = {
    payment_status: "paid",
    payment_method: "pix",
    settlement_nature: "coupon_zero",
    final_amount: 0,
    amount: 175,
    discount_amount: 175,
  };
  assert.equal(canRegisterOffGatewayPayment(payment).allowed, false);
  const cta = canShowOffGatewayRegularizeCta({ payment, hasPermission: true, surface: "order" });
  assert.equal(cta.show, false);
});

test("L. CTA não aparece sem permissão", () => {
  const payment = {
    payment_status: "paid",
    payment_method: "pix",
    final_amount: 175,
    amount: 175,
    price_origin: "legacy_known",
  };
  const cta = canShowOffGatewayRegularizeCta({ payment, hasPermission: false, surface: "order" });
  assert.equal(cta.show, false);
  assert.equal(cta.reason, null);
});

test("M. backend e action exigem finance.confirm_payment", async () => {
  const [action, rpc] = await Promise.all([
    read("src/app/financeiro/pagamento/actions.ts"),
    read("supabase/migrations/20261109000000_off_gateway_payment_settlement.sql"),
  ]);
  assert.match(action, /assertPermission\("finance\.confirm_payment"\)/);
  assert.match(action, /regularize_off_gateway_payment/);
  assert.match(rpc, /resolve_user_permission\(v_actor, 'finance\.confirm_payment'\)/);
  assert.match(rpc, /PENDING_OFF_GATEWAY_NOT_IMPLEMENTED/);
});

test("N. idempotência: duplo submit no client + RPC FOR UPDATE / idempotent", async () => {
  const [modal, rpc] = await Promise.all([
    read("src/app/financeiro/pagamento/off-gateway-modal.tsx"),
    read("supabase/migrations/20261109000000_off_gateway_payment_settlement.sql"),
  ]);
  assert.match(modal, /submittingRef/);
  assert.match(modal, /if \(pending \|\| submittingRef\.current\) return/);
  assert.match(rpc, /for update/);
  assert.match(rpc, /idempotent/);
  assert.match(rpc, /OFF_GATEWAY_ALREADY_RECORDED/);
});

test("O. ficha atualiza após sucesso sem F5 manual", async () => {
  const [action, modal, pedido] = await Promise.all([
    read("src/app/financeiro/pagamento/actions.ts"),
    read("src/app/financeiro/pagamento/off-gateway-modal.tsx"),
    read("src/app/inscricoes/pedido/[orderId]/page.tsx"),
  ]);
  assert.match(action, /revalidatePath\(`\/inscricoes\/pedido\/\$\{orderId\}`\)/);
  assert.match(modal, /router\.refresh\(\)/);
  assert.match(pedido, /OffGatewayPaymentModal/);
  assert.match(pedido, /Ações financeiras/);
  assert.match(pedido, /finance\.confirm_payment/);
});

test("P. audit trail canônico preservado", async () => {
  const rpc = await read("supabase/migrations/20261109000000_off_gateway_payment_settlement.sql");
  assert.match(rpc, /off_gateway_payment_regularized/);
  assert.match(rpc, /recorded_by/);
  assert.match(rpc, /order_id/);
  assert.match(rpc, /reason/);
  assert.doesNotMatch(rpc, /insert into public\.audit_logs[\s\S]{0,80}off_gateway_payment_regularized[\s\S]{0,200}insert into public\.audit_logs/);
});

test("Q. links Pedido ↔ Pagamento", async () => {
  const [pedido, pagamento, financeiro] = await Promise.all([
    read("src/app/inscricoes/pedido/[orderId]/page.tsx"),
    read("src/app/financeiro/pagamento/[paymentId]/page.tsx"),
    read("src/app/financeiro/page.tsx"),
  ]);
  assert.match(pedido, /Ver pagamento/);
  assert.match(pagamento, /Ver pedido/);
  assert.match(financeiro, /Ver pedido/);
  assert.match(financeiro, /Ver pagamento/);
});

test("R. status estornado permanece distinto de pago", () => {
  const view = presentFinancePayment(pixGateway({
    payment_status: "refunded",
    refund_status: "completed",
  }));
  assert.equal(view.badge, "refunded");
  assert.equal(view.statusLabel, "Estornado");
  assert.equal(view.moneyEntered, false);
  assert.equal(adminRefundVisualLabel("refunded"), "Estornado");
  assert.equal(adminRefundVisualLabel("paid"), "Pago");
});

test("filtro financeiro paid chama Pagos, não Confirmados", () => {
  assert.equal(financeSalesStatusFilterLabel("paid"), "Pagos");
  assert.notEqual(financeSalesStatusFilterLabel("paid"), "Confirmados");
});

test("PIX expirado com cobrança Asaas não é elegível; pending válido tampouco", () => {
  const expired = pixGateway({ payment_status: "expired", paid_at: null, final_amount: 89.49 });
  const pending = pixGateway({ payment_status: "pending", paid_at: null });
  assert.equal(canRegisterOffGatewayPayment(expired).allowed, false);
  assert.equal(canRegisterOffGatewayPayment(pending).allowed, false);
  assert.equal(canShowOffGatewayRegularizeCta({ payment: expired, hasPermission: true, surface: "order" }).show, false);
  assert.equal(canShowOffGatewayRegularizeCta({ payment: pending, hasPermission: true, surface: "order" }).show, false);
});

test("off_gateway já registrado não abre nova regularização na ficha", () => {
  const payment = {
    payment_status: "paid",
    payment_method: "courtesy",
    off_gateway_method: "pix",
    off_gateway_amount: 215,
    off_gateway_recorded_at: "2026-09-20T12:00:00.000Z",
    final_amount: 0,
  };
  const orderCta = canShowOffGatewayRegularizeCta({ payment, hasPermission: true, surface: "order" });
  assert.equal(orderCta.show, false);
  assert.equal(orderCta.replace, true);
  const paymentCta = canShowOffGatewayRegularizeCta({ payment, hasPermission: true, surface: "payment" });
  assert.equal(paymentCta.show, true);
  assert.equal(paymentCta.replace, true);
});

test("valor esperado da regularização usa o líquido do pedido, não a cobrança Asaas", () => {
  const payment = pixGateway({ final_amount: 89.49, amount: 175, discount_amount: 87.5 });
  assert.equal(offGatewayExpectedAmount(payment, 87.5), 87.5);
  assert.notEqual(offGatewayExpectedAmount(payment, 87.5), 89.49);
});

test("erros da RPC são humanizados e não vazam SQL", () => {
  assert.equal(
    humanizeOffGatewayError(new Error("PENDING_OFF_GATEWAY_NOT_IMPLEMENTED: regularizacao...")),
    "Regularização fora do gateway nesta versão só se aplica a pagamento já pago, sem emitir ingresso.",
  );
  assert.equal(
    humanizeOffGatewayError(new Error("duplicate key value violates unique constraint payments_pkey SQLSTATE 23505")),
    "Não foi possível registrar o pagamento fora do gateway. Tente novamente ou abra o pagamento no financeiro.",
  );
  assert.match(humanizeOffGatewayError(new Error("Sem permissao para confirmar pagamentos.")), /permissão/i);
});

test("pedido sem payment não improvisa cobrança no client", async () => {
  const pedido = await read("src/app/inscricoes/pedido/[orderId]/page.tsx");
  assert.doesNotMatch(pedido, /from\("payments"\)\.insert/);
  assert.match(pedido, /latestPayment\?\.id/);
});

test("financeiro não rotula paid como Confirmados", async () => {
  const [finance, labels] = await Promise.all([
    read("src/app/financeiro/page.tsx"),
    read("src/lib/finance/payment-presentation.ts"),
  ]);
  assert.match(labels, /return "Pagos"/);
  assert.doesNotMatch(labels, /Confirmados/);
  assert.doesNotMatch(finance, /paid: "Confirmados"/);
  assert.doesNotMatch(finance, /payment_status === "paid" \? "Confirmado"/);
  assert.match(finance, /presentFinancePayment/);
  assert.match(finance, /financeSalesStatusFilterLabel/);
});
