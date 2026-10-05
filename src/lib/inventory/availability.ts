/**
 * Semântica de exibição do estoque de camisetas.
 *
 * reserved_quantity continua sendo DEMANDA/COMPROMISSO — não bloqueia
 * entrega física. A entrega valida estoque físico (total - delivered).
 *
 * Disponível físico = peças ainda no estoque real.
 * Livre para reservar = físico − reservas pendentes (pode ser negativo).
 * Falta encomendar = demanda acima do físico, por variante, sem compensar
 * sobra de outro tamanho. No modo sob encomenda isso é operacional, não erro.
 *
 * Display admin (Livre para reservar) pode ser negativo.
 * Nova reserva / select de checkout usa availableForNewReservation, que
 * trunca em zero. A trava continua em events.limit_shirt_selection_to_stock.
 */

export type ShirtStockQuantities = {
  totalQuantity: number;
  reservedQuantity: number;
  deliveredQuantity: number;
};

export type ShirtStockAvailability = {
  physicalAvailable: number;
  availableForReservation: number;
  toOrderQuantity: number;
  overbooked: boolean;
};

function asInt(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function asNonNegativeInt(value: number) {
  return Math.max(0, asInt(value));
}

/** MAX(total_quantity - delivered_quantity, 0) */
export function physicalAvailable(totalQuantity: number, deliveredQuantity: number) {
  return asNonNegativeInt(asInt(totalQuantity) - asInt(deliveredQuantity));
}

/** Estoque físico atual − reservas pendentes. Pode ser negativo. */
export function availableForReservation(
  totalQuantity: number,
  deliveredQuantity: number,
  reservedQuantity: number,
) {
  return physicalAvailable(totalQuantity, deliveredQuantity) - asNonNegativeInt(reservedQuantity);
}

/**
 * Quantidade livre para uma NOVA reserva.
 * max(total - delivered - reserved - unaccountedPending, 0)
 *
 * Entregue nunca volta a ficar disponível. reserved legado de
 * shirt_inventory NÃO deve ser passado aqui — usar a demanda canônica
 * de event_kit_item_variant_inventory.
 */
export function availableForNewReservation(
  totalQuantity: number,
  deliveredQuantity: number,
  reservedQuantity: number,
  unaccountedPendingQuantity = 0,
) {
  return Math.max(
    0,
    availableForReservation(totalQuantity, deliveredQuantity, reservedQuantity)
      - asNonNegativeInt(unaccountedPendingQuantity),
  );
}

export const SHIRT_LOW_STOCK_THRESHOLD = 5;

export function shirtAvailabilityText(availableStock: number, enforcePhysicalStock: boolean) {
  if (!enforcePhysicalStock) return 'Disponivel para encomenda';
  const available = asNonNegativeInt(availableStock);
  if (available <= 0) return 'Esgotado';
  if (available === 1) return 'Resta apenas 1 unidade';
  if (available <= SHIRT_LOW_STOCK_THRESHOLD) return `Restam apenas ${available} unidades`;
  return 'Disponivel';
}

/** max(0, reservadas − estoque físico). Não compensa sobra de outra variante. */
export function toOrderQuantity(
  totalQuantity: number,
  deliveredQuantity: number,
  reservedQuantity: number,
) {
  return Math.max(0, -availableForReservation(totalQuantity, deliveredQuantity, reservedQuantity));
}

export function resolveShirtStockAvailability(input: ShirtStockQuantities): ShirtStockAvailability {
  const physical = physicalAvailable(input.totalQuantity, input.deliveredQuantity);
  const reserved = asNonNegativeInt(input.reservedQuantity);
  const available = availableForReservation(
    input.totalQuantity,
    input.deliveredQuantity,
    input.reservedQuantity,
  );
  return {
    physicalAvailable: physical,
    availableForReservation: available,
    toOrderQuantity: Math.max(0, -available),
    overbooked: reserved > physical,
  };
}
