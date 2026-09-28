import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { presentSupportOrder, presentSupportOrderFromRecord, summarizeSupportOrders, COUPON_NOT_PAYMENT_COPY } from "../src/lib/orders/support-presentation.ts";
import { formatDateBR } from "../src/lib/utils/date.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const now = new Date("2026-09-24T15:00:00.000Z");

function pixPayment(overrides = {}) {
  return {
    payment_status: "pending",
    payment_method: "pix",
    created_at: "2026-09-22T23:21:28.548377+00:00",
    paid_at: null,
    expires_at: "2026-09-23T02:59:59-03:00",
    final_amount: 89.49,
    payment_fee_customer_amount: 1.99,
    settlement_nature: "gateway",
    provider: "asaas",
    gateway_payment_id: "pay_x",
    gateway_account_key: "asaas-conta-live-01",
    gateway_environment: "production",
    ...overrides,
  };
}

function orderInput(overrides = {}) {
  return {
    orderId: "order-1",
    displayNumber: 1966,
    orderNumber: "MIL-2026-00001966",
    orderStatus: "pending",
    buyerType: "account",
    baseAmount: 175,
    discountAmount: 87.5,
    finalAmount: 87.5,
    couponCode: null,
    createdAt: "2026-09-22T23:21:28.548377+00:00",
    payment: pixPayment(),
    now,
    ...overrides,
  };
}

test("A. pedido com PIX pago aparece PAGO e com valor pago", () => {
  const view = presentSupportOrder(orderInput({
    displayNumber: 1086,
    orderStatus: "confirmed",
    discountAmount: 0,
    finalAmount: 175,
    couponCode: null,
    payment: pixPayment({
      payment_status: "paid",
      paid_at: "2026-09-22T23:40:00.000Z",
      final_amount: 176.99,
    }),
  }));
  assert.equal(view.situationBadge, "paid");
  assert.equal(view.isPaid, true);
  assert.equal(view.paidAmount, 176.99);
  assert.equal(view.formaLabel, "PIX");
  assert.equal(view.gatewayLabel, "Asaas");
  assert.equal(view.paymentDisplayStatus, "paid");
  assert.ok(view.paidAt);
  assert.equal(view.expiredAt, null);
});

test("B. PIX expirado com orders.status pending aparece EXPIRADO, nao PENDENTE", () => {
  const view = presentSupportOrder(orderInput({
    couponCode: null,
    discountAmount: 0,
    finalAmount: 175,
    payment: pixPayment({ payment_status: "expired", final_amount: 176.99 }),
  }));
  assert.equal(view.situationBadge, "expired");
  assert.equal(view.commercialStatus, "expired");
  assert.equal(view.isPaid, false);
  assert.equal(view.paidAmount, null);
  assert.equal(view.paymentDisplayStatus, "expired");
  assert.ok(view.expiredAt);
});

test("C. #001966 cupom + PIX expirado: EXPIRADO, cupom visivel, aplicacao nao e pagamento", () => {
  const view = presentSupportOrder(orderInput({ couponCode: "RITACHATA" }));
  assert.equal(view.orderNumber, "#001966");
  assert.equal(view.situationBadge, "expired");
  assert.equal(view.couponCode, "RITACHATA");
  assert.equal(view.discountAmount, 87.5);
  assert.equal(view.afterDiscountAmount, 87.5);
  assert.equal(view.chargedAmount, 89.49);
  assert.equal(view.isPaid, false);
  assert.equal(view.paidAmount, null);
  assert.equal(view.couponDoesNotMeanPaid, true);
  assert.equal(view.originLabel, "Compra pelo site");
  assert.equal(formatDateBR(view.createdAt), "22/09/2026");
  assert.match(COUPON_NOT_PAYMENT_COPY, /cupom/i);
});

test("D. #002055 cupom + PIX pago: PAGO e ainda mostra o cupom", () => {
  const view = presentSupportOrder(orderInput({
    displayNumber: 2055,
    orderNumber: "MIL-2026-00002055",
    orderStatus: "confirmed",
    couponCode: "RITACHATA",
    payment: pixPayment({
      payment_status: "paid",
      paid_at: "2026-09-22T23:50:00.000Z",
      final_amount: 89.49,
    }),
  }));
  assert.equal(view.orderNumber, "#002055");
  assert.equal(view.situationBadge, "paid");
  assert.equal(view.isPaid, true);
  assert.equal(view.paidAmount, 89.49);
  assert.equal(view.couponCode, "RITACHATA");
  assert.equal(view.couponDoesNotMeanPaid, true);
});

test("E. cortesia nao aparece como pago", () => {
  const view = presentSupportOrder(orderInput({
    orderStatus: "confirmed",
    discountAmount: 0,
    finalAmount: 0,
    couponCode: null,
    payment: {
      payment_status: "paid",
      payment_method: "courtesy",
      final_amount: 0,
      settlement_nature: "courtesy",
      provider: null,
      gateway_payment_id: null,
    },
  }));
  assert.equal(view.situationBadge, "courtesy");
  assert.equal(view.isPaid, false);
  assert.equal(view.paidAmount, null);
  assert.equal(view.chargedAmount, null);
  assert.equal(view.gatewayLabel, "—");
});

test("F. cupom 100% usa badge proprio e nao e pagamento", () => {
  const view = presentSupportOrder(orderInput({
    orderStatus: "confirmed",
    discountAmount: 175,
    finalAmount: 0,
    couponCode: "FULL100",
    payment: {
      payment_status: "paid",
      payment_method: "pix",
      final_amount: 0,
      settlement_nature: "coupon_zero",
      provider: null,
      gateway_payment_id: null,
    },
  }));
  assert.equal(view.situationBadge, "coupon_zero");
  assert.equal(view.isPaid, false);
  assert.equal(view.paidAmount, null);
  assert.equal(view.chargedAmount, null);
});

test("G. fora do gateway nao se confunde com PIX Asaas", () => {
  const view = presentSupportOrder(orderInput({
    orderStatus: "confirmed",
    discountAmount: 0,
    finalAmount: 175,
    couponCode: null,
    payment: {
      payment_status: "paid",
      payment_method: "pix",
      paid_at: "2026-09-22T12:00:00.000Z",
      final_amount: 175,
      settlement_nature: "off_gateway",
      off_gateway_method: "pix",
      off_gateway_amount: 175,
      off_gateway_recorded_at: "2026-09-22T12:00:00.000Z",
      provider: null,
      gateway_payment_id: null,
    },
  }));
  assert.equal(view.situationBadge, "off_gateway");
  assert.equal(view.gatewayLabel, "Fora do gateway");
  assert.equal(view.isPaid, true);
  assert.equal(view.paidAmount, 175);
  assert.equal(view.chargedAmount, 175);
  assert.doesNotMatch(view.formaLabel + view.gatewayLabel, /Asaas/i);
});

test("H. cadastro com varios pedidos resume pagos e expirados pelo status comercial", () => {
  const orders = [
    presentSupportOrder(orderInput({ couponCode: "RITACHATA" })),
    presentSupportOrder(orderInput({
      orderId: "order-2",
      displayNumber: 2055,
      orderStatus: "confirmed",
      couponCode: "RITACHATA",
      payment: pixPayment({ payment_status: "paid", paid_at: "2026-09-22T23:50:00.000Z" }),
    })),
  ];
  const summary = summarizeSupportOrders(orders);
  assert.equal(summary.total, 2);
  assert.equal(summary.expired, 1);
  assert.equal(summary.paid, 1);
  const fromRecord = presentSupportOrderFromRecord({
    id: "order-2",
    display_number: 2055,
    status: "pending",
    buyer_type: "account",
    base_amount: 175,
    discount_amount: 87.5,
    final_amount: 87.5,
    payments: [pixPayment({ payment_status: "paid", paid_at: "2026-09-22T23:50:00.000Z" })],
  }, { couponCode: "RITACHATA", now });
  assert.equal(fromRecord.situationBadge, "paid");
  assert.notEqual(fromRecord.situationBadge, "pending");
});

test("presentSupportOrder reusa as fontes canonicas, nao redefine paid/expired/cortesia", async () => {
  const helper = await read("src/lib/orders/support-presentation.ts");
  assert.match(helper, /resolveCommercialStatus/);
  assert.match(helper, /resolvePaymentDisplayStatus/);
  assert.match(helper, /resolveSettlementNature/);
  assert.match(helper, /resolveCouponUsagePaymentView/);
  assert.match(helper, /orderChargeBreakdown/);
  assert.match(helper, /paymentView\.paidAmount/);
  assert.doesNotMatch(helper, /function situationBadge/);
});

test("ficha do pedido, cadastro, historico e pulseira usam a apresentacao canonica", async () => {
  const [pedido, cadastro, historico, panel, row, expanded, turbo, badge] = await Promise.all([
    read("src/app/inscricoes/pedido/[orderId]/page.tsx"),
    read("src/app/cadastros/[id]/page.tsx"),
    read("src/app/minha-conta/historico/page.tsx"),
    read("src/app/operacoes/components/WristbandLinkedPanel.tsx"),
    read("src/app/operacoes/components/OperationRow.tsx"),
    read("src/app/operacoes/components/ExpandedTicketDetails.tsx"),
    read("src/app/operacoes/components/TurboMode.tsx"),
    read("src/components/admin/AdminStatusBadge.tsx"),
  ]);

  assert.match(pedido, /presentSupportOrder/);
  assert.match(pedido, /chargedAmount == null \? "—"/);
  assert.match(pedido, /href="\/pedidos"/);
  assert.match(pedido, /Situação comercial/);
  assert.match(pedido, /COUPON_NOT_PAYMENT_COPY/);
  assert.match(pedido, /Ver cadastro/);
  assert.match(pedido, /Valor original/);
  assert.match(pedido, /Valor pago/);
  assert.match(pedido, /Expirado em/);
  assert.match(pedido, /applied_coupon_id/);

  assert.match(cadastro, /<h2 className="text-lg font-semibold">Resumo<\/h2>/);
  assert.match(cadastro, /<h2 className="text-lg font-semibold">Pedidos<\/h2>/);
  assert.match(cadastro, /presentSupportOrderFromRecord/);
  assert.match(cadastro, /AdminStatusBadge status=\{order\.situationBadge\}/);
  assert.match(cadastro, /Ver pedido/);
  assert.match(cadastro, /getStatusLabel/);
  assert.match(cadastro, /hasPermission\("wristbands\.view"\)/);
  assert.match(cadastro, /ticket\.wristbandCode/);
  assert.match(cadastro, /formatDateTimeBR\(String\(contact\.created_at\)\)/);
  assert.match(cadastro, /Pedido \{ticket\.orderNumber\}/);
  assert.match(cadastro, /roleLabel/);

  assert.match(historico, /resolveAccountOrderStatus\(order\)/);
  assert.match(historico, /getAccountOrders/);
  assert.doesNotMatch(historico, /status: normalizeStatus\(String\(order\.status/);

  assert.match(panel, /canViewCode = false/);
  assert.match(row, /canViewCode=\{capabilities\.canViewWristband\}/);
  assert.match(expanded, /canViewCode=\{capabilities\.canViewWristband\}/);
  assert.match(expanded, /capabilities\.canViewWristband \? <>:/);
  assert.match(turbo, /canViewWristband/);
  assert.match(turbo, /canViewWristband \? activeWristbandCode : 'Vinculada'/);
  assert.match(badge, /off_gateway: \{ label: 'Fora do gateway'/);
});

test("I. usuario sem wristbands.view nao ve o codigo da pulseira", async () => {
  const [panel, cadastro] = await Promise.all([
    read("src/app/operacoes/components/WristbandLinkedPanel.tsx"),
    read("src/app/cadastros/[id]/page.tsx"),
  ]);
  assert.match(panel, /canViewCode \? \(/);
  assert.match(panel, /Vinculada/);
  assert.match(cadastro, /wristbandCode: canViewWristband \? \(wristbandCodeByTicketId/);
  assert.doesNotMatch(cadastro, /participant_wristbands\(/);
});
