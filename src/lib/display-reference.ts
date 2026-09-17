const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TECHNICAL_PREFIX_PATTERN = /^(?:ADMIN|MIL|ITEM)-/i;

export function formatDisplayNumber(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? `#${String(number).padStart(6, '0')}` : null;
}

export function legacyOrderDisplayNumber(orderNumber: unknown) {
  const match = String(orderNumber ?? '').match(/^MIL-\d{4}-(\d+)$/i);
  return match ? formatDisplayNumber(Number(match[1])) : null;
}

export function orderDisplayReference(displayNumber: unknown, legacyOrderNumber?: unknown) {
  return formatDisplayNumber(displayNumber) ?? legacyOrderDisplayNumber(legacyOrderNumber) ?? 'sem número';
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
  return UUID_PATTERN.test(normalized) || TECHNICAL_PREFIX_PATTERN.test(normalized);
}
