export const SHIRT_TYPES = ["Camiseta", "Babylook"] as const;

export const OFFICIAL_SHIRT_SIZE_ORDER = ["PP", "P", "M", "G", "GG", "EG", "EXG", "EXGG"] as const;

export const SHIRT_SIZES = {
  Camiseta: [...OFFICIAL_SHIRT_SIZE_ORDER],
  Babylook: [...OFFICIAL_SHIRT_SIZE_ORDER],
} as const;

export type ShirtType = (typeof SHIRT_TYPES)[number];
export type ShirtSize = (typeof SHIRT_SIZES)[ShirtType][number];

/** Rotulo de exibicao da camiseta; "Camiseta"/"Babylook" sao os valores
 * canonicos gravados no banco (SHIRT_TYPES), aqui so viram um rotulo mais
 * claro pro comprador -- nunca afeta o valor persistido/enviado ao backend.
 * Compartilhado entre CartStep e a pagina de detalhe do pedido. */
export function shirtDisplayLabel(shirtType: string | null | undefined): string | null {
  if (!shirtType) return null;
  const normalized = shirtType.trim().toLowerCase();
  if (normalized === "camiseta") return "Camiseta Masculina";
  if (normalized === "babylook") return "Babylook Feminina";
  return shirtType;
}

export type ShirtInventorySourceRow = {
  id?: string | null | undefined;
  shirt_type: string | null | undefined;
  shirt_size: string | null | undefined;
  total_quantity: number | null | undefined;
  reserved_quantity: number | null | undefined;
  delivered_quantity: number | null | undefined;
};

export type ShirtInventoryVariant = {
  id: string;
  shirt_type: ShirtType;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
  available_quantity: number;
};

const SHIRT_TYPE_ORDER: Record<ShirtType, number> = {
  Camiseta: 1,
  Babylook: 2,
};

const SHIRT_SIZE_ORDER: Record<string, number> = OFFICIAL_SHIRT_SIZE_ORDER.reduce<Record<string, number>>((acc, size, index) => {
  acc[size] = index + 1;
  return acc;
}, {});

export function normalizeShirtType(value: string | null | undefined): ShirtType | "" {
  const normalized = String(value ?? "").trim();
  return SHIRT_TYPES.includes(normalized as ShirtType) ? (normalized as ShirtType) : "";
}

export function normalizeShirtSize(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

export function getShirtSizesForType(shirtType: string | null | undefined): readonly string[] {
  const normalizedType = normalizeShirtType(shirtType);
  if (!normalizedType) {
    return [];
  }
  return SHIRT_SIZES[normalizedType];
}

export function getShirtTypeOrder(shirtType: string | null | undefined): number {
  const normalizedType = normalizeShirtType(shirtType);
  return normalizedType ? SHIRT_TYPE_ORDER[normalizedType] : 99;
}

export function getShirtSizeOrder(shirtSize: string | null | undefined): number {
  const normalizedSize = normalizeShirtSize(shirtSize);
  return SHIRT_SIZE_ORDER[normalizedSize] ?? 99;
}

export function makeShirtInventoryKey(shirtType: string | null | undefined, shirtSize: string | null | undefined): string {
  return `${normalizeShirtType(shirtType)}::${normalizeShirtSize(shirtSize)}`;
}

export function buildShirtInventoryVariants(rows: ShirtInventorySourceRow[]): ShirtInventoryVariant[] {
  const grouped = new Map<string, ShirtInventoryVariant>();

  for (const row of rows) {
    const shirtType = normalizeShirtType(row.shirt_type);
    const shirtSize = normalizeShirtSize(row.shirt_size);
    if (!shirtType || !shirtSize) {
      continue;
    }

    const key = makeShirtInventoryKey(shirtType, shirtSize);
    const total = Number(row.total_quantity ?? 0);
    const reserved = Number(row.reserved_quantity ?? 0);
    const delivered = Number(row.delivered_quantity ?? 0);

    const existing = grouped.get(key);
    if (existing) {
      existing.total_quantity += total;
      existing.reserved_quantity += reserved;
      existing.delivered_quantity += delivered;
      existing.available_quantity = existing.total_quantity - existing.reserved_quantity - existing.delivered_quantity;
      continue;
    }

    grouped.set(key, {
      id: row.id ? String(row.id) : key,
      shirt_type: shirtType,
      shirt_size: shirtSize,
      total_quantity: total,
      reserved_quantity: reserved,
      delivered_quantity: delivered,
      available_quantity: total - reserved - delivered,
    });
  }

  return Array.from(grouped.values()).sort((a, b) => {
    const typeDiff = getShirtTypeOrder(a.shirt_type) - getShirtTypeOrder(b.shirt_type);
    if (typeDiff !== 0) return typeDiff;
    return getShirtSizeOrder(a.shirt_size) - getShirtSizeOrder(b.shirt_size);
  });
}
