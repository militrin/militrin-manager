/**
 * Regras operacionais do Dashboard de ingressos e demanda de camiseta.
 * Espelham reconcile_event_shirt_variant_inventory (kits + loja + carrinho)
 * e o status real de tickets (active | used | cancelled). Este modulo nao
 * escreve inventory, nao reemite ingresso e nao altera reservas.
 */

export function isOperationalTicketStatus(status: unknown) {
  const normalized = String(status ?? '').toLowerCase();
  return normalized === 'active' || normalized === 'used';
}

export function isCancelledTicketStatus(status: unknown) {
  return String(status ?? '').toLowerCase() === 'cancelled';
}

function positiveQuantity(value: unknown) {
  const quantity = Number(value ?? 0);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}

function hasVariantId(value: unknown) {
  return Boolean(String(value ?? '').trim());
}

/** Demanda de kit que ainda ocupa reserved_quantity. Check-in (used) nao libera: so entrega ou cancelamento do kit. */
export function pendingKitReservationQuantity(input: {
  ticketStatus: unknown;
  kitStatus: unknown;
  variantId: unknown;
  quantity?: unknown;
}) {
  if (!isOperationalTicketStatus(input.ticketStatus)) return 0;
  const kitStatus = String(input.kitStatus ?? '');
  if (kitStatus === 'delivered' || kitStatus === 'cancelled') return 0;
  if (!hasVariantId(input.variantId)) return 0;
  return positiveQuantity(input.quantity ?? 1);
}

export function additionalStoreReservationQuantity(input: {
  storeOrderStatus: unknown;
  lineStatus: unknown;
  linkedVariantId: unknown;
  quantity?: unknown;
}) {
  if (!hasVariantId(input.linkedVariantId)) return 0;
  const orderStatus = String(input.storeOrderStatus ?? '');
  if (orderStatus === 'cancelled' || orderStatus === 'expired') return 0;
  const lineStatus = String(input.lineStatus ?? '');
  if (lineStatus !== 'reserved' && lineStatus !== 'confirmed') return 0;
  return positiveQuantity(input.quantity ?? 1);
}

export function additionalCartReservationQuantity(input: {
  itemKind: unknown;
  orderStatus: unknown;
  lineStatus: unknown;
  linkedVariantId: unknown;
  quantity?: unknown;
}) {
  if (String(input.itemKind ?? '') !== 'product') return 0;
  if (!hasVariantId(input.linkedVariantId)) return 0;
  const orderStatus = String(input.orderStatus ?? '');
  if (orderStatus === 'cancelled' || orderStatus === 'expired' || orderStatus === 'refunded') return 0;
  const lineStatus = String(input.lineStatus ?? '');
  if (['cancelled', 'expired', 'refunded', 'transferred', 'delivered'].includes(lineStatus)) return 0;
  return positiveQuantity(input.quantity ?? 1);
}

export function reservedShirtTotal(kitPending: number, additional: number) {
  return kitPending + additional;
}

/** Saldo operacional assinado: estoque fisico restante − demanda ainda reservada. Pode ser negativo. */
export function freeToReserveQuantity(physicalTotal: number, delivered: number, reserved: number) {
  const physical = Math.max(0, Number(physicalTotal) - Number(delivered));
  return physical - Math.max(0, Number(reserved));
}

/** Falta encomendar nesta variante. Sobra de outro tamanho nao entra. */
export function shirtDeficitQuantity(physicalTotal: number, delivered: number, reserved: number) {
  return Math.max(0, -freeToReserveQuantity(physicalTotal, delivered, reserved));
}
