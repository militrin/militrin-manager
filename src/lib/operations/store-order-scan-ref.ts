import { parseStoredMilOrderNumber } from "../display-reference.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATIONAL_TOKEN_PATTERN = /^(ITEM|UNIT)-/i;
const DISPLAY_PATTERN = /^#?0*(\d{1,8})$/;

export type StoreOrderScanRef = {
  displayNumber: number | null;
  orderNumber: string | null;
};

/**
 * Referências de pedido da Loja que o comprovante/PDF realmente gravam no QR.
 * Não cobre tickets.token nem tokens operacionais ITEM-/UNIT-.
 */
export function parseStoreOrderScanRef(rawValue: string): StoreOrderScanRef {
  const value = rawValue.trim().replace(/^pedido\s*:?\s*/i, '').trim();
  if (!value) return { displayNumber: null, orderNumber: null };
  if (UUID_PATTERN.test(value) || OPERATIONAL_TOKEN_PATTERN.test(value)) {
    return { displayNumber: null, orderNumber: null };
  }

  const mil = parseStoredMilOrderNumber(value);
  if (mil) {
    return { displayNumber: mil.sequence, orderNumber: mil.canonical };
  }

  const displayMatch = value.match(DISPLAY_PATTERN);
  if (displayMatch) {
    const displayNumber = Number(displayMatch[1]);
    if (Number.isSafeInteger(displayNumber) && displayNumber > 0) {
      return { displayNumber, orderNumber: null };
    }
  }

  return { displayNumber: null, orderNumber: value };
}

export function formatStoreVariantLabel(variant: { name?: string | null; value?: string | null } | null | undefined) {
  if (!variant) return null;
  const label = `${variant.name ?? ""} ${variant.value ?? ""}`.replace(/\s+/g, " ").trim();
  return label || null;
}
