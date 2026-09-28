export const GLOBAL_SEARCH_GROUP_LIMIT = 5;
export const GLOBAL_SEARCH_NAME_MIN_CHARS = 3;
export const GLOBAL_SEARCH_FETCH_CAP = 20;
export const GLOBAL_SEARCH_DEBOUNCE_MS = 280;

export const GLOBAL_SEARCH_GROUPS = ["people", "orders", "tickets", "wristbands"] as const;

export const GLOBAL_SEARCH_GROUP_LABELS: Record<(typeof GLOBAL_SEARCH_GROUPS)[number], string> = {
  people: "Pessoas",
  orders: "Pedidos",
  tickets: "Ingressos",
  wristbands: "Pulseiras",
};

export const WRISTBAND_STATUS_LABELS: Record<string, string> = {
  active: "Vinculada",
  linked: "Vinculada",
  unlinked: "Desvinculada",
  replaced: "Substituída",
  blocked: "Bloqueada",
  inactive: "Inativa",
};
