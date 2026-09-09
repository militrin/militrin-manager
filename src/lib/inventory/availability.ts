/**
 * Semântica de exibição do estoque de camisetas.
 *
 * reserved_quantity continua sendo DEMANDA/COMPROMISSO — não bloqueia
 * entrega física. A entrega valida estoque físico (total - delivered).
 *
 * Disponível físico = peças ainda no estoque real.
 * Livre para reserva = peças que ainda podemos prometer a novas pessoas.
 */

export type ShirtStockQuantities = {
  totalQuantity: number;
  reservedQuantity: number;
  deliveredQuantity: number;
};

export type ShirtStockAvailability = {
  physicalAvailable: number;
  availableForReservation: number;
  overbooked: boolean;
};

function asNonNegativeInt(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** MAX(total_quantity - delivered_quantity, 0) */
export function physicalAvailable(totalQuantity: number, deliveredQuantity: number) {
  return asNonNegativeInt(totalQuantity - deliveredQuantity);
}

/** MAX(total_quantity - delivered_quantity - reserved_quantity, 0) */
export function availableForReservation(
  totalQuantity: number,
  deliveredQuantity: number,
  reservedQuantity: number,
) {
  return asNonNegativeInt(totalQuantity - deliveredQuantity - reservedQuantity);
}

export function resolveShirtStockAvailability(input: ShirtStockQuantities): ShirtStockAvailability {
  const physical = physicalAvailable(input.totalQuantity, input.deliveredQuantity);
  const reserved = asNonNegativeInt(input.reservedQuantity);
  return {
    physicalAvailable: physical,
    availableForReservation: availableForReservation(
      input.totalQuantity,
      input.deliveredQuantity,
      input.reservedQuantity,
    ),
    overbooked: reserved > physical,
  };
}
