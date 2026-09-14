import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  additionalCartReservationQuantity,
  additionalStoreReservationQuantity,
  freeToReserveQuantity,
  isCancelledTicketStatus,
  isOperationalTicketStatus,
  pendingKitReservationQuantity,
  reservedShirtTotal,
  shirtDeficitQuantity,
} from '../src/lib/dashboard/operational-shirt-demand.ts';

test('ticket cancelado nao e operacional e entra em cancelados', () => {
  assert.equal(isOperationalTicketStatus('cancelled'), false);
  assert.equal(isCancelledTicketStatus('cancelled'), true);
  assert.equal(isOperationalTicketStatus('active'), true);
  assert.equal(isOperationalTicketStatus('used'), true);
  assert.equal(isCancelledTicketStatus('active'), false);
  assert.equal(isCancelledTicketStatus('used'), false);
});

test('kit cancelado ou entregue nao reserva; kit pendente de ticket operacional reserva', () => {
  const base = { variantId: 'variant-1', quantity: 1 };
  assert.equal(pendingKitReservationQuantity({ ...base, ticketStatus: 'active', kitStatus: 'pending' }), 1);
  assert.equal(pendingKitReservationQuantity({ ...base, ticketStatus: 'active', kitStatus: 'reserved' }), 1);
  assert.equal(pendingKitReservationQuantity({ ...base, ticketStatus: 'active', kitStatus: 'cancelled' }), 0);
  assert.equal(pendingKitReservationQuantity({ ...base, ticketStatus: 'active', kitStatus: 'delivered' }), 0);
  assert.equal(pendingKitReservationQuantity({ ...base, ticketStatus: 'cancelled', kitStatus: 'pending' }), 0);
  assert.equal(pendingKitReservationQuantity({ ...base, ticketStatus: 'used', kitStatus: 'pending' }), 1);
  assert.equal(pendingKitReservationQuantity({ ticketStatus: 'active', kitStatus: 'pending', variantId: null, quantity: 1 }), 0);
});

test('1 active + kit pending => reservado', () => {
  assert.equal(pendingKitReservationQuantity({ ticketStatus: 'active', kitStatus: 'pending', variantId: 'v1', quantity: 1 }), 1);
});

test('2 used + kit pending => continua reservado', () => {
  assert.equal(pendingKitReservationQuantity({ ticketStatus: 'used', kitStatus: 'reserved', variantId: 'v1', quantity: 1 }), 1);
});

test('3 used + kit delivered => nao reservado', () => {
  assert.equal(pendingKitReservationQuantity({ ticketStatus: 'used', kitStatus: 'delivered', variantId: 'v1', quantity: 1 }), 0);
});

test('4 active + kit delivered => nao reservado', () => {
  assert.equal(pendingKitReservationQuantity({ ticketStatus: 'active', kitStatus: 'delivered', variantId: 'v1', quantity: 1 }), 0);
});

test('5 cancelled => nao reservado', () => {
  assert.equal(pendingKitReservationQuantity({ ticketStatus: 'cancelled', kitStatus: 'pending', variantId: 'v1', quantity: 1 }), 0);
  assert.equal(pendingKitReservationQuantity({ ticketStatus: 'cancelled', kitStatus: 'delivered', variantId: 'v1', quantity: 1 }), 0);
});

test('6 undo check-in com kit pendente nao altera reserva', () => {
  const pending = { kitStatus: 'pending', variantId: 'v1', quantity: 1 };
  assert.equal(
    pendingKitReservationQuantity({ ...pending, ticketStatus: 'used' }),
    pendingKitReservationQuantity({ ...pending, ticketStatus: 'active' }),
  );
});

test('7 entrega e undo entrega alteram reserva; check-in nao', () => {
  const variant = { variantId: 'v1', quantity: 1 };
  const beforeDelivery = pendingKitReservationQuantity({ ...variant, ticketStatus: 'used', kitStatus: 'pending' });
  const afterDelivery = pendingKitReservationQuantity({ ...variant, ticketStatus: 'used', kitStatus: 'delivered' });
  const afterUndoDelivery = pendingKitReservationQuantity({ ...variant, ticketStatus: 'used', kitStatus: 'pending' });
  const afterCheckin = pendingKitReservationQuantity({ ...variant, ticketStatus: 'used', kitStatus: 'pending' });
  const afterUndoCheckin = pendingKitReservationQuantity({ ...variant, ticketStatus: 'active', kitStatus: 'pending' });
  assert.equal(beforeDelivery, 1);
  assert.equal(afterDelivery, 0);
  assert.equal(afterUndoDelivery, 1);
  assert.equal(afterCheckin, 1);
  assert.equal(afterUndoCheckin, 1);
});

test('camiseta extra confirmada entra; cancelada, expirada ou nao-camiseta nao entra', () => {
  assert.equal(additionalStoreReservationQuantity({ storeOrderStatus: 'confirmed', lineStatus: 'confirmed', linkedVariantId: 'v1', quantity: 1 }), 1);
  assert.equal(additionalStoreReservationQuantity({ storeOrderStatus: 'confirmed', lineStatus: 'reserved', linkedVariantId: 'v1', quantity: 2 }), 2);
  assert.equal(additionalStoreReservationQuantity({ storeOrderStatus: 'cancelled', lineStatus: 'confirmed', linkedVariantId: 'v1', quantity: 1 }), 0);
  assert.equal(additionalStoreReservationQuantity({ storeOrderStatus: 'expired', lineStatus: 'confirmed', linkedVariantId: 'v1', quantity: 1 }), 0);
  assert.equal(additionalStoreReservationQuantity({ storeOrderStatus: 'confirmed', lineStatus: 'cancelled', linkedVariantId: 'v1', quantity: 1 }), 0);
  assert.equal(additionalStoreReservationQuantity({ storeOrderStatus: 'confirmed', lineStatus: 'delivered', linkedVariantId: 'v1', quantity: 1 }), 0);
  assert.equal(additionalStoreReservationQuantity({ storeOrderStatus: 'confirmed', lineStatus: 'confirmed', linkedVariantId: null, quantity: 1 }), 0);

  assert.equal(additionalCartReservationQuantity({ itemKind: 'product', orderStatus: 'confirmed', lineStatus: 'confirmed', linkedVariantId: 'v1', quantity: 1 }), 1);
  assert.equal(additionalCartReservationQuantity({ itemKind: 'ticket', orderStatus: 'confirmed', lineStatus: 'confirmed', linkedVariantId: 'v1', quantity: 1 }), 0);
  assert.equal(additionalCartReservationQuantity({ itemKind: 'product', orderStatus: 'cancelled', lineStatus: 'confirmed', linkedVariantId: 'v1', quantity: 1 }), 0);
  assert.equal(additionalCartReservationQuantity({ itemKind: 'product', orderStatus: 'confirmed', lineStatus: 'delivered', linkedVariantId: 'v1', quantity: 1 }), 0);
});

test('reservadas = kit pendente de tickets validos + adicionais reservados', () => {
  assert.equal(reservedShirtTotal(515, 1), 516);
  assert.equal(reservedShirtTotal(0, 0), 0);
});

test('saldo operacional assinado e falta encomendar nao se compensam entre variantes', () => {
  assert.equal(freeToReserveQuantity(612, 0, 516), 96);
  assert.equal(freeToReserveQuantity(612, 10, 506), 96);
  assert.equal(shirtDeficitQuantity(612, 0, 516), 0);
  assert.equal(shirtDeficitQuantity(500, 0, 516), 16);
  assert.equal(freeToReserveQuantity(70, 0, 75), -5);
  assert.equal(shirtDeficitQuantity(70, 0, 75), 5);
  assert.equal(freeToReserveQuantity(140, 0, 127) + freeToReserveQuantity(70, 0, 75), 8);
  assert.equal(shirtDeficitQuantity(140, 0, 127) + shirtDeficitQuantity(70, 0, 75), 5);
});

test('dashboard nao escreve inventory nem reemite ingresso neste ajuste', async () => {
  const source = await readFile(new URL('../src/lib/dashboard/admin-dashboard-data.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.update\(|\.insert\(|\.upsert\(|rpc\('reconcile_event_shirt_variant_inventory'/);
  assert.match(source, /put\('confirmed', 'Ingressos ativos', activeTickets\.length/);
  assert.match(source, /put\('cancelled', 'Cancelados', cancelledTickets\.length/);
  assert.match(source, /isCancelledTicketStatus/);
  assert.match(source, /isOperationalTicketStatus/);
  assert.match(source, /pendingKitReservationQuantity/);
  assert.match(source, /additionalStoreReservationQuantity/);
  assert.match(source, /shirts_additional/);
});

test('cards do painel separam ingresso ativo de inscricao comercial e mostram decomposicao de reservas', async () => {
  const page = await readFile(new URL('../src/app/painel/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /label="Ingressos ativos"/);
  assert.match(page, /metric\('confirmed'\)/);
  assert.match(page, /label="Cancelados"/);
  assert.match(page, /metric\('cancelled'\)/);
  assert.match(page, /label="Camisetas adicionais"/);
  assert.match(page, /label="De kits pendentes"/);
  assert.match(page, /label="Saldo líquido"/);
  assert.match(page, /label="Falta encomendar"/);
  assert.match(page, /Check-in não libera reserva/);
  assert.doesNotMatch(page, /label="Confirmadas"/);
  assert.doesNotMatch(page, /label="Canceladas"/);
});

test('RPC canonica deixa de exigir ticket.status=active e aceita used', async () => {
  const [legacy, current] = await Promise.all([
    readFile(new URL('../supabase/migrations/20260890000000_reconcile_unified_event_shirt_demand.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20261024000000_shirt_demand_keeps_reservation_after_checkin.sql', import.meta.url), 'utf8'),
  ]);
  assert.match(legacy, /ticket\.status='active' and kit_link\.status not in\('delivered','cancelled'\)/);
  assert.match(current, /ticket\.status in\('active','used'\) and kit_link\.status not in\('delivered','cancelled'\)/);
  assert.doesNotMatch(current, /ticket\.status='active' and kit_link/);
  assert.doesNotMatch(current, /update public\.event_kit_item_variant_inventory[\s\S]*where inventory\.event_id/);
});
