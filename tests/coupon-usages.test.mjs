import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatEventDateTimeWithSeconds } from "../src/lib/utils/date.ts";
import {
  couponHasRecordedUses,
  formatCouponUsesLabel,
  presentCouponUsage,
  remainingCouponUses,
  UNIDENTIFIED_CADASTRO_LABEL,
} from "../src/lib/coupons/usage.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function ritachataRow(overrides = {}) {
  return {
    order_id: "7b3411c1-2608-4e3c-ba75-1f4cc889881e",
    display_number: 1966,
    order_number: "MIL-2026-00001966",
    order_status: "expired",
    buyer_type: "account",
    user_id: "c7a1f152-403f-4888-80f5-abdf6d662251",
    contact_id: "contact-rita",
    contact_name: "Rita Kieling",
    contact_email: "rita@example.com",
    buyer_name: "Rita Kieling",
    buyer_email: "rita@example.com",
    applied_at: "2026-09-22T23:21:28.548377+00:00",
    original_amount: 175,
    discount_amount: 87.5,
    after_discount_amount: 87.5,
    payment_status: "expired",
    payment_method: "pix",
    payment_paid_at: null,
    payment_final_amount: 89.49,
    payment_fee_customer_amount: 1.99,
    settlement_nature: "gateway",
    provider: "asaas",
    gateway_payment_id: "pay_x",
    gateway_account_key: "asaas-conta-live-01",
    gateway_environment: "production",
    off_gateway_method: null,
    off_gateway_amount: null,
    off_gateway_recorded_at: null,
    reservation_expires_at: "2026-09-23T03:00:00.000Z",
    price_origin: null,
    ...overrides,
  };
}

test("usos do cupom formatam limite e ilimitado", () => {
  assert.equal(formatCouponUsesLabel(1, 1), "1 / 1");
  assert.equal(formatCouponUsesLabel(3, 10), "3 / 10");
  assert.equal(formatCouponUsesLabel(3, null), "3 / ilimitado");
  assert.equal(remainingCouponUses(1, 1), 0);
  assert.equal(remainingCouponUses(3, null), null);
  assert.equal(couponHasRecordedUses(1), true);
  assert.equal(couponHasRecordedUses(0), false);
});

test("RITACHATA expirado continua como utilizacao e nao pago", () => {
  const usage = presentCouponUsage(ritachataRow());
  assert.equal(usage.orderNumber, "#001966");
  assert.equal(usage.cadastroName, "Rita Kieling");
  assert.equal(usage.cadastroIdentified, true);
  assert.equal(usage.discountAmount, 87.5);
  assert.equal(usage.consumesLimit, true);
  assert.equal(usage.payment.badge, "expired");
  assert.equal(usage.payment.isPaid, false);
  assert.equal(usage.payment.paidAt, null);
  assert.equal(usage.payment.paidAmount, null);
  assert.match(usage.payment.methodLabel, /PIX/i);
  assert.equal(formatEventDateTimeWithSeconds(usage.appliedAt), "22/09/2026 às 20:21:28");
});

test("utilizacao nao usa titular do ingresso no lugar do cadastro", () => {
  const usage = presentCouponUsage(ritachataRow({
    contact_id: null,
    contact_name: null,
    buyer_name: "Rita Kieling",
    holder_full_name: "Titular Diferente",
  }));
  assert.equal(usage.cadastroIdentified, false);
  assert.equal(usage.cadastroName, UNIDENTIFIED_CADASTRO_LABEL);
  assert.equal(usage.buyerFallbackName, "Rita Kieling");
  assert.doesNotMatch(usage.cadastroName, /Titular Diferente/);
});

test("pagamento pago e cortesia nao se confundem com uso do cupom", () => {
  const paid = presentCouponUsage(ritachataRow({
    order_status: "confirmed",
    payment_status: "paid",
    payment_paid_at: "2026-09-22T23:40:00.000Z",
    payment_final_amount: 87.5,
  }));
  assert.equal(paid.consumesLimit, true);
  assert.equal(paid.payment.badge, "paid");
  assert.equal(paid.payment.isPaid, true);

  const courtesy = presentCouponUsage(ritachataRow({
    payment_status: "paid",
    payment_method: "courtesy",
    settlement_nature: "courtesy",
    payment_final_amount: 0,
    gateway_payment_id: null,
    provider: null,
  }));
  assert.equal(courtesy.consumesLimit, true);
  assert.equal(courtesy.payment.badge, "courtesy");
  assert.equal(courtesy.payment.isPaid, false);
});

test("RPC de utilizacoes e somente leitura e usa applied_coupon_id", async () => {
  const sql = await read("supabase/migrations/20261115000000_list_organization_coupon_usages.sql");
  assert.match(sql, /list_organization_coupon_usages/);
  assert.match(sql, /o\.applied_coupon_id = p_coupon_id/);
  assert.match(sql, /current_user_has_permission\('coupons\.view'\)/);
  assert.match(sql, /registration_contacts/);
  assert.doesNotMatch(sql, /holder_full_name/);
  assert.doesNotMatch(sql, /update\s+public\.(coupons|orders|payments)/i);
  assert.doesNotMatch(sql, /insert\s+into\s+public\.(coupons|orders|payments)/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.(coupons|orders|payments)/i);
  assert.doesNotMatch(sql, /used_count\s*=/);
});

test("admin de cupons expoe Ver utilizacoes e diferencia pagamento", async () => {
  const [ui, panel, actions, page] = await Promise.all([
    read("src/app/cupons/ui.tsx"),
    read("src/app/cupons/CouponUsagesPanel.tsx"),
    read("src/app/cupons/actions.ts"),
    read("src/app/cupons/page.tsx"),
  ]);
  assert.match(ui, /Ver utilizações/);
  assert.match(ui, /Nenhuma utilização/);
  assert.match(ui, /formatCouponUsesLabel/);
  assert.match(panel, /Utilizou o cupom ≠ pagou o pedido/);
  assert.match(panel, /Ver cadastro/);
  assert.match(panel, /Ver pedido/);
  assert.match(panel, /\/cadastros\/\$\{usage\.cadastroId\}/);
  assert.match(panel, /\/inscricoes\/pedido\/\$\{usage\.orderId\}/);
  assert.match(actions, /getCouponUsagesAction[\s\S]*assertPermission\("coupons\.view"\)/);
  assert.match(actions, /list_organization_coupon_usages/);
  assert.match(page, /canManage \? </);
  assert.match(page, /hasPermission\("participants\.view"\)/);
});
