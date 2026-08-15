import type { PickupEvent } from "../types";

// Colunas por variante — sem "Resumo" (sumário já fica sob o nome na linha).
// withShirtWithKit : Nome | Categoria | Camiseta | Pagamento | Kit | Check-in | Ações (7)
// noShirtWithKit   : Nome | Categoria | Pagamento | Kit | Check-in | Ações     (6)
// withShirtNoKit   : Nome | Categoria | Camiseta | Pagamento | Check-in | Ações (6)
// minimal          : Nome | Categoria | Pagamento | Check-in | Ações            (5)
const GRID_CONFIG = {
  withShirtWithKit: {
    header: "grid-cols-[minmax(240px,2fr)_120px_130px_110px_90px_90px_minmax(150px,1fr)]",
    row:    "lg:grid-cols-[minmax(240px,2fr)_120px_130px_110px_90px_90px_minmax(150px,1fr)]",
    minWidth: "",
  },
  noShirtWithKit: {
    header: "grid-cols-[minmax(260px,2fr)_140px_110px_90px_90px_minmax(160px,1fr)]",
    row:    "lg:grid-cols-[minmax(260px,2fr)_140px_110px_90px_90px_minmax(160px,1fr)]",
    minWidth: "",
  },
  withShirtNoKit: {
    header: "grid-cols-[minmax(260px,2fr)_130px_130px_110px_90px_minmax(170px,1fr)]",
    row:    "lg:grid-cols-[minmax(260px,2fr)_130px_130px_110px_90px_minmax(170px,1fr)]",
    minWidth: "",
  },
  minimal: {
    header: "grid-cols-[minmax(280px,2.2fr)_150px_120px_90px_minmax(190px,1fr)]",
    row:    "lg:grid-cols-[minmax(280px,2.2fr)_150px_120px_90px_minmax(190px,1fr)]",
    minWidth: "",
  },
};

export function getOperationsGridConfig(selectedEvent: PickupEvent | null) {
  const hasShirt = Boolean(selectedEvent?.has_shirt);
  const hasKit = Boolean(selectedEvent?.has_kit);

  if (hasShirt && hasKit) return GRID_CONFIG.withShirtWithKit;
  if (!hasShirt && hasKit) return GRID_CONFIG.noShirtWithKit;
  if (hasShirt && !hasKit) return GRID_CONFIG.withShirtNoKit;
  return GRID_CONFIG.minimal;
}
