import { isLegacyImportPriceOrigin } from '../imports/legacy-price.ts';

export type OperationalPaymentKind =
  | 'paid'
  | 'legacy_paid'
  | 'courtesy'
  | 'pending'
  | 'refunded'
  | 'cancelled';

export type OperationalPaymentState = {
  kind: OperationalPaymentKind;
  label: string;
  methodLabel: string;
  operational: boolean;
  blockReason: string | null;
};

const REAL_PENDING_BLOCK =
  'Pagamento ainda não confirmado. A entrega/check-in não pode ser realizada.';

function normalize(value: string | null | undefined) {
  return String(value ?? '').trim().toLowerCase();
}

function isCourtesyMethod(method: string) {
  return method === 'courtesy' || method === 'admin_courtesy';
}

function methodDisplay(method: string | null | undefined, priceOrigin?: string | null) {
  if (isLegacyImportPriceOrigin(priceOrigin)) return 'Não informado';
  const normalized = String(method ?? '').trim();
  if (!normalized || normalized === '-') return 'Não informado';
  if (normalized === 'courtesy' || normalized === 'admin_courtesy') return 'Cortesia';
  if (normalized === 'pix') return 'PIX';
  if (normalized === 'credit_card') return 'Cartão';
  if (normalized === 'cash') return 'Dinheiro';
  return normalized;
}

export function resolveOperationalPaymentState(input: {
  paymentStatus?: string | null;
  paymentMethod?: string | null;
  priceOrigin?: string | null;
  ticketStatus?: string | null;
}): OperationalPaymentState {
  const status = normalize(input.paymentStatus);
  const method = normalize(input.paymentMethod);
  const ticketStatus = normalize(input.ticketStatus);
  const methodLabel = methodDisplay(input.paymentMethod, input.priceOrigin);
  const legacy = isLegacyImportPriceOrigin(input.priceOrigin);

  if (ticketStatus === 'cancelled' || ticketStatus === 'canceled' || status === 'cancelled' || status === 'canceled') {
    return {
      kind: 'cancelled',
      label: 'Cancelado',
      methodLabel,
      operational: false,
      blockReason: 'Ingresso cancelado.',
    };
  }

  if (status === 'refunded') {
    return {
      kind: 'refunded',
      label: 'Reembolsado',
      methodLabel,
      operational: false,
      blockReason: 'Pagamento reembolsado. A entrega/check-in não pode ser realizada.',
    };
  }

  if (isCourtesyMethod(method) && (status === 'paid' || status === 'confirmed' || !status)) {
    return {
      kind: 'courtesy',
      label: 'Cortesia',
      methodLabel: 'Cortesia',
      operational: true,
      blockReason: null,
    };
  }

  if (legacy && (status === 'paid' || status === 'confirmed' || status === 'pending' || status === '' || status === 'processing')) {
    return {
      kind: 'legacy_paid',
      label: 'Pago · Legado',
      methodLabel: 'Não informado',
      operational: true,
      blockReason: null,
    };
  }

  if (status === 'paid' || status === 'confirmed') {
    return {
      kind: 'paid',
      label: 'Pago',
      methodLabel,
      operational: true,
      blockReason: null,
    };
  }

  if (status === 'pending' || status === 'processing' || status === 'reserved' || status === '') {
    return {
      kind: 'pending',
      label: 'Pendente',
      methodLabel,
      operational: false,
      blockReason: REAL_PENDING_BLOCK,
    };
  }

  return {
    kind: 'pending',
    label: 'Pendente',
    methodLabel,
    operational: false,
    blockReason: REAL_PENDING_BLOCK,
  };
}
