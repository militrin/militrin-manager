import { orderDisplayReference } from '../display-reference.ts';
import { formatStoreVariantLabel } from '../operations/store-order-scan-ref.ts';
import { formatDateBR, formatDateTimeBR } from '../utils/date.ts';

export type StorePickupQrMode = 'per_line' | 'per_unit' | 'none';
export type StorePickupStatus = 'pending' | 'delivered' | 'none' | 'unavailable';
export type StorePaymentStatusKind = 'confirmed' | 'pending' | 'cancelled' | 'expired' | 'other';

export const STORE_PICKUP_PASS_COPY = {
  brand: 'Militrin',
  badgeTitle: 'Loja oficial',
  badgeSubtitle: 'Produto',
  variantLabel: 'Variante',
  quantityLabel: 'Quantidade',
  orderLabel: 'Pedido',
  orderDateLabel: 'Data do pedido',
  paymentConfirmed: 'Pagamento confirmado',
  pickupPending: 'Retirada pendente',
  pickupDelivered: 'Item retirado',
  pickupNone: 'Retirada pela organização',
  instructionPending: 'Apresente este QR Code na retirada do seu item.',
  instructionDelivered: 'Item já retirado.',
  instructionNone: 'Este item não possui QR de retirada — a entrega é confirmada pela organização.',
  qrUnavailable: 'O QR Code fica disponível assim que o pagamento é confirmado.',
  downloadImage: 'Baixar imagem',
  downloadPdf: 'Baixar PDF',
  generatingImage: 'Gerando imagem...',
  generatingPdf: 'Gerando PDF...',
  qrImageAlt: 'QR Code de retirada do item da Loja',
  noVariant: 'Padrão',
} as const;

export type StorePickupPassData = {
  productName: string;
  productImageUrl: string | null;
  variantLabel: string | null;
  quantity: number;
  quantityLabel: string;
  orderNumber: string;
  orderDateLabel: string;
  qrPayload: string | null;
  pickupQrMode: StorePickupQrMode;
  unitLabel: string | null;
  paymentStatus: StorePaymentStatusKind;
  paymentStatusLabel: string;
  pickupStatus: StorePickupStatus;
  pickupStatusLabel: string;
  deliveredAt: string | null;
  deliveredAtLabel: string | null;
  instruction: string;
  eventName: string | null;
  participantName: string | null;
  canShowQr: boolean;
};

const OPERATIONAL_QR_PATTERN = /^(ITEM|UNIT)-/i;

export function normalizeStorePickupQrMode(value: string | null | undefined): StorePickupQrMode {
  if (value === 'per_unit' || value === 'none') return value;
  return 'per_line';
}

export function isOperationalStoreQrPayload(value: string | null | undefined) {
  return OPERATIONAL_QR_PATTERN.test(String(value ?? '').trim());
}

/**
 * Fonte canônica do QR apresentado ao participante (tela, imagem e PDF).
 *
 * - per_line → store_order_items.qr_token (ITEM-…)
 * - per_unit com quantity > 1 → store_order_item_pickup_units.qr_token (UNIT-…)
 * - per_unit com quantity = 1 → o modelo atual reutiliza o qr_token da linha
 * - none → sem QR
 *
 * Nunca devolve order_number, #display_number, UUID interno ou dado pessoal.
 */
export function resolveStorePickupQrPayload(input: {
  pickupQrMode: string | null | undefined;
  quantity: number;
  itemQrToken?: string | null;
  unitQrToken?: string | null;
}): string | null {
  const mode = normalizeStorePickupQrMode(input.pickupQrMode);
  if (mode === 'none') return null;

  const itemToken = String(input.itemQrToken ?? '').trim();
  const unitToken = String(input.unitQrToken ?? '').trim();

  if (mode === 'per_unit' && Number(input.quantity) > 1) {
    return isOperationalStoreQrPayload(unitToken) ? unitToken : null;
  }

  return isOperationalStoreQrPayload(itemToken) ? itemToken : null;
}

export function pickStoreProductImageUrl(
  images:
    | Array<{
        image_url?: unknown;
        url?: unknown;
        is_primary?: unknown;
        isPrimary?: unknown;
        sort_order?: unknown;
      }>
    | null
    | undefined,
): string | null {
  const list = (Array.isArray(images) ? images : [])
    .map((image) => ({
      url: String(image.image_url ?? image.url ?? '').trim(),
      primary: Boolean(image.is_primary ?? image.isPrimary),
      sort: Number(image.sort_order ?? 0),
    }))
    .filter((image) => image.url);
  const primary = list.find((image) => image.primary);
  if (primary) return primary.url;
  list.sort((a, b) => a.sort - b.sort);
  return list[0]?.url ?? null;
}

export function formatStoreQuantityLabel(quantity: number) {
  const count = Number.isFinite(quantity) ? Math.max(1, Math.trunc(quantity)) : 1;
  return count === 1 ? '1 unidade' : `${count} unidades`;
}

export function resolveStorePickupStatus(input: {
  itemStatus?: string | null;
  deliveredAt?: string | null;
  pickupQrMode?: string | null;
}): StorePickupStatus {
  const status = String(input.itemStatus ?? '').trim().toLowerCase();
  if (status === 'delivered' || input.deliveredAt) return 'delivered';
  if (status === 'confirmed') {
    return normalizeStorePickupQrMode(input.pickupQrMode) === 'none' ? 'none' : 'pending';
  }
  return 'unavailable';
}

export function resolveStorePaymentStatusKind(status: string | null | undefined): StorePaymentStatusKind {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized === 'confirmed' || normalized === 'paid' || normalized === 'delivered') return 'confirmed';
  if (normalized === 'pending' || normalized === 'reserved' || normalized === 'processing') return 'pending';
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'refunded') return 'cancelled';
  if (normalized === 'expired') return 'expired';
  return 'other';
}

function pickupStatusLabel(status: StorePickupStatus) {
  if (status === 'delivered') return STORE_PICKUP_PASS_COPY.pickupDelivered;
  if (status === 'pending') return STORE_PICKUP_PASS_COPY.pickupPending;
  if (status === 'none') return STORE_PICKUP_PASS_COPY.pickupNone;
  return 'Retirada indisponível';
}

function paymentStatusLabel(kind: StorePaymentStatusKind) {
  if (kind === 'confirmed') return STORE_PICKUP_PASS_COPY.paymentConfirmed;
  if (kind === 'pending') return 'Pagamento pendente';
  if (kind === 'cancelled') return 'Pagamento cancelado';
  if (kind === 'expired') return 'Pagamento expirado';
  return 'Pagamento';
}

function instructionFor(status: StorePickupStatus, _deliveredAtLabel: string | null) {
  if (status === 'delivered') return STORE_PICKUP_PASS_COPY.instructionDelivered;
  if (status === 'pending') return STORE_PICKUP_PASS_COPY.instructionPending;
  if (status === 'none') return STORE_PICKUP_PASS_COPY.instructionNone;
  return STORE_PICKUP_PASS_COPY.qrUnavailable;
}

export function buildStorePickupPassData(input: {
  productName: string;
  productImageUrl?: string | null;
  variant?: { name?: string | null; value?: string | null } | null;
  variantLabel?: string | null;
  quantity: number;
  displayNumber?: unknown;
  orderNumber?: string | null;
  orderCreatedAt?: string | null;
  itemStatus?: string | null;
  paymentStatus?: string | null;
  deliveredAt?: string | null;
  pickupQrMode?: string | null;
  itemQrToken?: string | null;
  unitQrToken?: string | null;
  unitLabel?: string | null;
  eventName?: string | null;
  participantName?: string | null;
}): StorePickupPassData {
  const quantity = Number.isFinite(input.quantity) ? Math.max(1, Math.trunc(input.quantity)) : 1;
  const pickupQrMode = normalizeStorePickupQrMode(input.pickupQrMode);
  const pickupStatus = resolveStorePickupStatus({
    itemStatus: input.itemStatus,
    deliveredAt: input.deliveredAt,
    pickupQrMode,
  });
  const paymentStatus = resolveStorePaymentStatusKind(input.paymentStatus ?? input.itemStatus);
  const deliveredAt = input.deliveredAt ? String(input.deliveredAt) : null;
  const deliveredAtLabel = deliveredAt ? formatDateTimeBR(deliveredAt, ' às ') : null;
  const qrPayload = resolveStorePickupQrPayload({
    pickupQrMode,
    quantity,
    itemQrToken: input.itemQrToken,
    unitQrToken: input.unitQrToken,
  });
  const canShowQr = Boolean(qrPayload) && (pickupStatus === 'pending' || pickupStatus === 'delivered');

  return {
    productName: String(input.productName || 'Produto').trim() || 'Produto',
    productImageUrl: input.productImageUrl ? String(input.productImageUrl).trim() || null : null,
    variantLabel: input.variantLabel ?? formatStoreVariantLabel(input.variant),
    quantity,
    quantityLabel: formatStoreQuantityLabel(quantity),
    orderNumber: orderDisplayReference(input.displayNumber, input.orderNumber),
    orderDateLabel: input.orderCreatedAt ? formatDateBR(input.orderCreatedAt) : '—',
    qrPayload,
    pickupQrMode,
    unitLabel: input.unitLabel ? String(input.unitLabel) : null,
    paymentStatus,
    paymentStatusLabel: paymentStatusLabel(paymentStatus),
    pickupStatus,
    pickupStatusLabel: pickupStatusLabel(pickupStatus),
    deliveredAt,
    deliveredAtLabel,
    instruction: instructionFor(pickupStatus, deliveredAtLabel),
    eventName: input.eventName ? String(input.eventName) : null,
    participantName: input.participantName ? String(input.participantName) : null,
    canShowQr,
  };
}

export function storePickupPassFileStem(pass: StorePickupPassData) {
  const order = pass.orderNumber.replace('#', '');
  const unit = pass.unitLabel ? `-${pass.unitLabel.replace(/\s+/g, '-').toLowerCase()}` : '';
  return `loja-retirada-${order}${unit}`;
}
