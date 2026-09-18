const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TECHNICAL_PREFIX_PATTERN = /^(?:ADMIN|ITEM)-/i;
const MIL_ORDER_NUMBER_PATTERN = /^MIL-(\d{4})-(\d+)$/i;

export type ParsedMilOrderNumber = {
  year: string;
  sequence: number;
  canonical: string;
};

export function formatDisplayNumber(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? `#${String(number).padStart(6, '0')}` : null;
}

export function parseStoredMilOrderNumber(orderNumber: unknown): ParsedMilOrderNumber | null {
  const match = String(orderNumber ?? '').trim().match(MIL_ORDER_NUMBER_PATTERN);
  if (!match) return null;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  return {
    year: match[1],
    sequence,
    canonical: `MIL-${match[1]}-${String(sequence).padStart(8, '0')}`,
  };
}

export function legacyOrderDisplayNumber(orderNumber: unknown) {
  const parsed = parseStoredMilOrderNumber(orderNumber);
  return parsed ? formatDisplayNumber(parsed.sequence) : null;
}

// Código público/operacional do pedido: o mesmo texto enviado ao Asaas
// (`Pedido MIL-YYYY-XXXXXXXX`). Não inventa ano. Pedidos ADMIN-/sem MIL
// caem no número curto `#001827` quando display_number existe.
export function publicOrderCode(displayNumber: unknown, orderNumber?: unknown) {
  return parseStoredMilOrderNumber(orderNumber)?.canonical
    ?? formatDisplayNumber(displayNumber)
    ?? 'sem número';
}

export function orderDisplayReference(displayNumber: unknown, legacyOrderNumber?: unknown) {
  return publicOrderCode(displayNumber, legacyOrderNumber);
}

export type ParsedPublicOrderQuery =
  | { kind: 'mil'; canonical: string; year: string; sequence: number }
  | { kind: 'sequence'; sequence: number };

export function parsePublicOrderQuery(raw: unknown): ParsedPublicOrderQuery | null {
  const stripped = String(raw ?? '').trim().replace(/^pedido\s*:?\s*/i, '').replace(/\s+/g, '');
  if (!stripped) return null;
  const mil = parseStoredMilOrderNumber(stripped);
  if (mil) {
    return { kind: 'mil', canonical: mil.canonical, year: mil.year, sequence: mil.sequence };
  }
  const digits = stripped.match(/^#?0*([1-9][0-9]{0,7})$/);
  if (!digits) return null;
  const sequence = Number(digits[1]);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null;
  return { kind: 'sequence', sequence };
}

export function orderMatchesPublicQuery(
  rawQuery: unknown,
  order: { displayNumber?: unknown; orderNumber?: unknown; publicCode?: string | null },
) {
  const parsed = parsePublicOrderQuery(rawQuery);
  if (!parsed) return false;
  const mil = parseStoredMilOrderNumber(order.orderNumber) ?? parseStoredMilOrderNumber(order.publicCode);
  const displaySequence = Number(order.displayNumber);
  const hasDisplay = Number.isSafeInteger(displaySequence) && displaySequence > 0;
  const publicCode = String(order.publicCode ?? publicOrderCode(order.displayNumber, order.orderNumber));
  const publicParsed = parsePublicOrderQuery(publicCode);

  if (parsed.kind === 'mil') {
    return mil?.canonical === parsed.canonical
      || (mil?.year === parsed.year && mil.sequence === parsed.sequence)
      || publicCode === parsed.canonical
      || (publicParsed?.kind === 'mil' && publicParsed.canonical === parsed.canonical);
  }

  return (hasDisplay && displaySequence === parsed.sequence)
    || mil?.sequence === parsed.sequence
    || (publicParsed?.kind === 'sequence' && publicParsed.sequence === parsed.sequence)
    || (publicParsed?.kind === 'mil' && publicParsed.sequence === parsed.sequence);
}

export function orderMatchesAdminSearch(
  rawQuery: unknown,
  order: {
    displayNumber?: unknown;
    orderNumber?: unknown;
    publicCode?: string | null;
    buyerName?: string | null;
    buyerEmail?: string | null;
    buyerCpf?: string | null;
  },
) {
  const trimmed = String(rawQuery ?? '').trim();
  if (!trimmed) return true;
  if (parsePublicOrderQuery(trimmed)) {
    return orderMatchesPublicQuery(trimmed, order);
  }
  const needle = trimmed.toLowerCase();
  const cpfQuery = trimmed.replace(/\D/g, '');
  const publicCode = String(order.publicCode ?? publicOrderCode(order.displayNumber, order.orderNumber)).toLowerCase();
  return publicCode.includes(needle)
    || String(order.buyerName ?? '').toLowerCase().includes(needle)
    || String(order.buyerEmail ?? '').toLowerCase().includes(needle)
    || (cpfQuery.length >= 3 && String(order.buyerCpf ?? '').replace(/\D/g, '').includes(cpfQuery));
}

export function publicOrderChargeDescription(orderNumber: unknown) {
  const parsed = parseStoredMilOrderNumber(orderNumber);
  if (parsed) return `Pedido ${parsed.canonical}`;
  const raw = String(orderNumber ?? '').trim();
  return raw ? `Pedido ${raw}` : undefined;
}

export type ParsedTicketDisplayCode = {
  displayNumber: number;
  itemPosition: number;
};

export function canonicalTicketDisplayCode(displayNumber: unknown, position: unknown, legacyOrderNumber?: unknown) {
  const order = formatDisplayNumber(displayNumber) ?? legacyOrderDisplayNumber(legacyOrderNumber);
  const itemPosition = Number(position);
  return order && Number.isSafeInteger(itemPosition) && itemPosition > 0
    ? `${order}-${String(itemPosition).padStart(2, '0')}`
    : null;
}

export function ticketDisplayReference(displayNumber: unknown, position: unknown, legacyOrderNumber?: unknown) {
  return canonicalTicketDisplayCode(displayNumber, position, legacyOrderNumber)
    ?? formatDisplayNumber(displayNumber)
    ?? legacyOrderDisplayNumber(legacyOrderNumber)
    ?? 'sem número';
}

export function parseTicketDisplayCode(raw: unknown): ParsedTicketDisplayCode | null {
  const normalized = String(raw ?? '').trim().replace(/\s+/g, '');
  const match = normalized.match(/^#?0*([1-9][0-9]{0,17})-0*([1-9][0-9]{0,8})$/);
  if (!match) return null;
  const displayNumber = Number(match[1]);
  const itemPosition = Number(match[2]);
  if (!Number.isSafeInteger(displayNumber) || !Number.isSafeInteger(itemPosition)) return null;
  return { displayNumber, itemPosition };
}

export function ticketMatchesExactDisplayCode(rawSearch: unknown, ticketCode: string | null | undefined) {
  const parsed = parseTicketDisplayCode(rawSearch);
  if (!parsed) return null;
  return ticketCode === ticketDisplayReference(parsed.displayNumber, parsed.itemPosition);
}

export function isTechnicalIdentifier(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (parseStoredMilOrderNumber(normalized)) return false;
  return UUID_PATTERN.test(normalized) || TECHNICAL_PREFIX_PATTERN.test(normalized);
}
