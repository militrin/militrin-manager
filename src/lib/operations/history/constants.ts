import type { OperationHistoryCategory } from "./types.ts";

export const PAGE_SIZE = 50;
export const RAW_FETCH_CHUNK = 1000;
export const RAW_FETCH_CAP = 15_000;

/** Agrupamento legado (somente histórico sem kit_delivered). */
export const LEGACY_GROUP_WINDOW_MS = 15_000;
/** Absorve logs satélite (itens, combined, check-in) ao redor do evento canônico. */
export const CANONICAL_ABSORB_WINDOW_MS = 15_000;
/** Check-in absorvido no visual de kit sem combined só com evidência estreita. */
export const COMBINED_CHECKIN_WINDOW_MS = 5_000;

export const ACTION_KIT_DELIVERED = "kit_delivered";
export const ACTION_KIT_DELIVERY_UNDONE = "kit_delivery_undone";
export const ACTION_KIT_ITEM_DELIVERED = "ticket_kit_item_delivered";
export const ACTION_KIT_ITEM_UNDONE = "ticket_kit_item_delivery_undone";
export const ACTION_COMBINED_KIT_CHECKIN = "combined_kit_delivery_and_checkin";
export const ACTION_CHECKIN = "ticket_checkin_entry";
export const ACTION_CHECKIN_UNDO = "ticket_checkin_undo";

export const HISTORY_AUDIT_ACTIONS = [
  ACTION_KIT_DELIVERED,
  ACTION_KIT_DELIVERY_UNDONE,
  ACTION_KIT_ITEM_DELIVERED,
  ACTION_KIT_ITEM_UNDONE,
  ACTION_COMBINED_KIT_CHECKIN,
  ACTION_CHECKIN,
  ACTION_CHECKIN_UNDO,
  "ticket_shirt_admin_changed",
  "ticket_shirt_admin_corrected_after_operation",
  "wristband_linked",
  "wristband_replaced",
  "wristband_unlinked",
  "wristband_blocked",
  "store_order_item_delivered",
  "store_order_item_delivery_undone",
  "store_item_admin_granted",
  "manual_ticket_issued",
  "manual_registration_order_created",
  "manual_unassigned_ticket_order_created",
] as const;

export const KIT_HISTORY_AUDIT_ACTIONS = [
  ACTION_KIT_DELIVERED,
  ACTION_KIT_DELIVERY_UNDONE,
  ACTION_KIT_ITEM_DELIVERED,
  ACTION_KIT_ITEM_UNDONE,
  ACTION_COMBINED_KIT_CHECKIN,
  "ticket_shirt_admin_changed",
  "ticket_shirt_admin_corrected_after_operation",
] as const;

export const HISTORY_HOLDER_OPERATIONS = [
  "holder_assigned",
  "holder_changed",
  "holder_removed",
  "ticket_transferred",
] as const;

export const FINANCIAL_AUDIT_ACTIONS = [
  "payment_confirmed",
  "payment_admin_confirmed",
  "registration_payment_confirmed",
  "imported_payment_confirmed",
  "payment_expired",
  "cart_coupon_applied",
] as const;

export const CATEGORY_LABELS: Record<OperationHistoryCategory | "all", string> = {
  all: "Todos",
  kit: "Kit",
  checkin: "Check-in",
  wristbands: "Pulseiras",
  holders: "Titularidade",
  tickets: "Ingressos",
  store: "Loja",
};

export const HISTORY_CATEGORIES: Array<OperationHistoryCategory | "all"> = [
  "all",
  "kit",
  "checkin",
  "wristbands",
  "holders",
  "tickets",
  "store",
];
