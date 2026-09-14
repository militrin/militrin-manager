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
 * Esta função NÃO decide se uma nova reserva é permitida. Essa trava continua
 * em events.limit_shirt_selection_to_stock / shirt_supply_mode='stock'.
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
