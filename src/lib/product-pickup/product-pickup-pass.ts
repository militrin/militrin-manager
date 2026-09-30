import { formatDisplayNumber, orderDisplayReference } from '../display-reference.ts';
import { additionalItemStatus, additionalItemStatusLabel, type AdditionalItemStatus } from '../operations/additional-product-items.ts';
import { formatDateTimeBR } from '../utils/date.ts';

export const PRODUCT_PICKUP_PASS_COPY = {
  brand: 'MILITRIN',
  title: 'RETIRADA DE PRODUTO',
  pending: 'Aguardando retirada',
  delivered: 'Entregue',
  instructionPending: 'Apresente este QR na retirada.',
  instructionDelivered: 'Produto entregue.',
  qrUnavailable: 'O QR fica disponível após a confirmação do pagamento.',
  qrImageAlt: 'QR Code de retirada do produto',
  orderLabel: 'Pedido',
  codeLabel: 'Código',
} as const;

export type ProductPickupQr = {
  unitLabel: string | null;
  qrDataUrl: string | null;
  qrPreview: string | null;
  alt: string;
};

export type ProductPickupPassData = {
  productName: string;
  quantityLabel: string;
  orderLabel: string;
  status: AdditionalItemStatus;
  statusLabel: string;
  deliveredAtLabel: string | null;
  instruction: string;
  qrs: ProductPickupQr[];
};

export function productPickupOrderLabel(displayNumber: unknown, orderNumber?: unknown) {
  return formatDisplayNumber(displayNumber) ?? orderDisplayReference(displayNumber, orderNumber);
}

export function formatProductQuantityLabel(quantity: number) {
  const count = Number.isFinite(quantity) ? Math.max(1, Math.trunc(quantity)) : 1;
  return count === 1 ? '1 unidade' : `${count} unidades`;
}

export function formatOperationalQrPreview(token: string | null | undefined) {
  const value = String(token ?? '').trim();
  const match = value.match(/^(ITEM|UNIT)-([0-9A-F]+)$/i);
  if (!match) return null;
  const prefix = match[1].toUpperCase();
  const body = match[2].toUpperCase();
  if (body.length <= 4) return `${prefix}-${body}`;
  return `${prefix}-${body.slice(0, 4)}…`;
}

export function buildProductPickupPassData(input: {
  productName: string;
  quantity: number;
  displayNumber?: unknown;
  orderNumber?: unknown;
  itemStatus?: string | null;
  deliveredAt?: string | null;
  orderStatus?: string | null;
  paymentStatus?: string | null;
  qrs?: ProductPickupQr[];
}): ProductPickupPassData {
  const status = additionalItemStatus({
    itemStatus: input.itemStatus,
    deliveredAt: input.deliveredAt,
    orderStatus: input.orderStatus,
    paymentStatus: input.paymentStatus,
  });
  const deliveredAtLabel = input.deliveredAt ? formatDateTimeBR(input.deliveredAt, ' às ') : null;
  return {
    productName: String(input.productName || 'Produto').trim() || 'Produto',
    quantityLabel: formatProductQuantityLabel(input.quantity),
    orderLabel: productPickupOrderLabel(input.displayNumber, input.orderNumber),
    status,
    statusLabel: additionalItemStatusLabel(status),
    deliveredAtLabel,
    instruction:
      status === 'delivered'
        ? PRODUCT_PICKUP_PASS_COPY.instructionDelivered
        : status === 'confirmed'
          ? PRODUCT_PICKUP_PASS_COPY.instructionPending
          : PRODUCT_PICKUP_PASS_COPY.qrUnavailable,
    qrs: input.qrs ?? [],
  };
}
