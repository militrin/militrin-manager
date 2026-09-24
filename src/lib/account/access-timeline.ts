function isUuidLike(value: string | null | undefined) {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value).trim()));
}

export type AccessTimelineSource = "functional" | "audit" | "history";

export type AccessTimelineEvent = {
  id: string;
  occurredAt: string;
  type: string;
  title: string;
  description: string | null;
  actorName: string | null;
  actorSource: string | null;
  source: AccessTimelineSource;
  metadata: Record<string, unknown>;
  status: string | null;
  showStatus: boolean;
};

export type AccessTimelineAuditRow = {
  id?: unknown;
  action?: unknown;
  entity_type?: unknown;
  entity_id?: unknown;
  created_at?: unknown;
  details?: unknown;
};

export type AccessTimelineHistoryRow = {
  id?: unknown;
  operation?: unknown;
  created_at?: unknown;
  actor_user_id?: unknown;
  actor_origin?: unknown;
  previous_holder_name?: unknown;
  new_holder_name?: unknown;
  reason?: unknown;
  reason_code?: unknown;
  reason_text?: unknown;
  previous_owner_user_id?: unknown;
  new_owner_user_id?: unknown;
};

type BuildInput = {
  ticketId: string;
  orderId?: string | null;
  orderItemId?: string | null;
  ownerUserId?: string | null;
  issuedAt?: string | null;
  usedAt?: string | null;
  confirmedAt?: string | null;
  paidAt?: string | null;
  paymentMethod?: string | null;
  orderReference?: string | null;
  eventName?: string | null;
  kitFullyDelivered?: boolean;
  kitDeliveredAt?: string | null;
  shirtLabel?: string | null;
  auditRows?: AccessTimelineAuditRow[];
  holderRows?: AccessTimelineHistoryRow[];
  ownerRows?: AccessTimelineHistoryRow[];
  operatorNames?: Map<string, string>;
};

const ISSUANCE_TYPES = new Set([
  "ticket_issued",
  "manual_ticket_issued",
  "manual_registration_order_created",
  "manual_unassigned_ticket_order_created",
  "imported_ticket_issue_finalized",
  "create_imported_order_and_issue_ticket",
  "confirm_order_and_issue_ticket",
  "confirm_order_item_and_issue_ticket",
  "confirm_order_payment_and_issue_tickets",
]);

const CHECKIN_TYPES = new Set(["ticket_checkin_entry", "participant_checkin_entry"]);
const KIT_ITEM_TYPES = new Set(["ticket_kit_item_delivered", "participant_kit_item_delivered"]);
const PAYMENT_TYPES = new Set(["payment_confirmed", "payment_admin_confirmed", "registration_payment_confirmed", "imported_payment_confirmed"]);
const AUTOMATIC_TYPES = new Set(["reservation_expired_released", "payment_expired", "store_order_expired"]);

const ACCOUNT_TITLES: Record<string, string> = {
  ticket_issued: "Acesso emitido",
  manual_ticket_issued: "Acesso emitido",
  manual_registration_order_created: "Acesso emitido",
  manual_unassigned_ticket_order_created: "Acesso emitido",
  imported_ticket_issue_finalized: "Acesso emitido",
  create_imported_order_and_issue_ticket: "Acesso emitido",
  confirm_order_and_issue_ticket: "Acesso emitido",
  confirm_order_item_and_issue_ticket: "Acesso emitido",
  confirm_order_payment_and_issue_tickets: "Acesso emitido",
  payment_confirmed: "Pagamento confirmado",
  payment_admin_confirmed: "Pagamento confirmado",
  registration_payment_confirmed: "Pagamento confirmado",
  imported_payment_confirmed: "Pagamento confirmado",
  payment_expired: "Pagamento expirado",
  ticket_kit_item_delivered: "Kit retirado",
  participant_kit_item_delivered: "Kit retirado",
  ticket_kit_item_delivery_undone: "Retirada do kit desfeita",
  combined_kit_delivery_and_checkin: "Kit retirado + check-in realizado",
  ticket_checkin_entry: "Check-in realizado",
  participant_checkin_entry: "Check-in realizado",
  ticket_checkin_undo: "Check-in desfeito",
  ticket_shirt_changed: "Tamanho da camiseta alterado",
  ticket_shirt_admin_changed: "Tamanho da camiseta alterado",
  ticket_shirt_admin_corrected_after_operation: "Camiseta corrigida",
  order_item_shirt_changed: "Tamanho da camiseta alterado",
  ticket_category_changed: "Categoria alterada",
  ticket_notes_updated: "Observações atualizadas",
  holder_changed: "Titular alterado",
  holder_assigned: "Titular definido",
  ticket_holder_assigned: "Titular definido",
  ticket_transferred: "Titular alterado",
  admin_ticket_holder_transferred: "Titular alterado",
  holder_removed: "Titular removido",
  self_ticket_holder_materialized: "Titular definido",
  named_ticket_holder_materialized: "Titular definido",
  named_ticket_holder_textual: "Titular definido",
  owner_assigned: "Acesso vinculado à conta",
  owner_transferred: "Propriedade transferida",
  ticket_account_owner_assigned: "Conta proprietária alterada",
  shared_email_account_owner_assigned: "Acesso vinculado à conta",
  unassigned_manual_ticket_owner_repaired: "Propriedade regularizada",
  wristband_linked: "Pulseira vinculada",
  wristband_replaced: "Pulseira substituída",
  wristband_unlinked: "Pulseira desvinculada",
  wristband_blocked: "Pulseira bloqueada",
  store_order_item_delivered: "Item adicional entregue",
  store_order_item_delivery_undone: "Entrega de item adicional desfeita",
  store_item_admin_granted: "Item adicional concedido",
  order_item_product_delivered: "Item adicional entregue",
  order_item_product_confirmed: "Item adicional confirmado",
  admin_ticket_cancelled: "Acesso cancelado",
  ticket_cancellation_reclassified: "Cancelamento reclassificado",
  ticket_item_change_requested: "Alteração de item solicitada",
  ticket_item_change_approved: "Alteração de item aprovada",
  ticket_item_change_rejected: "Alteração de item rejeitada",
  reservation_expired_released: "Reserva de camiseta liberada",
  ticket_resent: "Ingresso reenviado",
  ticket_history_exported: "Histórico exportado",
  cart_coupon_applied: "Cupom aplicado",
  cart_product_added: "Item adicionado ao pedido",
  cart_product_removed: "Item removido do pedido",
  cart_product_quantity_changed: "Quantidade do pedido alterada",
  kit_pending: "Aguardando retirada do kit",
};

const REASON_LABELS: Record<string, string> = {
  registration_correction: "Correção de cadastro",
  buyer_request: "Solicitação do comprador",
  holder_request: "Solicitação do titular",
  third_party_ticket: "Ingresso para terceiro",
  administrative_adjustment: "Cortesia / ajuste administrativo",
  issuance_error: "Erro de emissão",
  system_error: "Falha do sistema",
  data_regularization: "Regularização de dados",
  intended_owner_materialized: "Materialização do proprietário pretendido",
  administrative_transfer: "Transferência administrativa",
  shared_email: "E-mail compartilhado",
  other: "Outro",
  damaged: "Danificada",
  lost: "Perdida",
  incorrectly_linked: "Vinculada incorretamente",
  operational_swap: "Troca operacional",
};

// Maior = mais tarde no fluxo de negócio. Só desempata timestamp idêntico.
const TIE_RANK: Record<string, number> = {
  payment_expired: 5,
  reservation_expired_released: 6,
  cart_coupon_applied: 8,
  cart_product_added: 8,
  cart_product_removed: 8,
  cart_product_quantity_changed: 8,
  payment_confirmed: 10,
  payment_admin_confirmed: 10,
  registration_payment_confirmed: 10,
  imported_payment_confirmed: 10,
  ticket_issued: 20,
  manual_ticket_issued: 20,
  manual_registration_order_created: 20,
  manual_unassigned_ticket_order_created: 20,
  imported_ticket_issue_finalized: 20,
  create_imported_order_and_issue_ticket: 20,
  confirm_order_and_issue_ticket: 20,
  confirm_order_item_and_issue_ticket: 20,
  confirm_order_payment_and_issue_tickets: 20,
  owner_assigned: 30,
  unassigned_manual_ticket_owner_repaired: 30,
  shared_email_account_owner_assigned: 30,
  owner_transferred: 32,
  ticket_account_owner_assigned: 32,
  holder_assigned: 35,
  ticket_holder_assigned: 35,
  self_ticket_holder_materialized: 35,
  named_ticket_holder_materialized: 35,
  named_ticket_holder_textual: 35,
  holder_changed: 36,
  ticket_transferred: 36,
  admin_ticket_holder_transferred: 36,
  holder_removed: 36,
  ticket_shirt_changed: 40,
  ticket_shirt_admin_changed: 40,
  order_item_shirt_changed: 40,
  ticket_category_changed: 40,
  ticket_notes_updated: 40,
  ticket_item_change_requested: 41,
  ticket_item_change_approved: 42,
  ticket_item_change_rejected: 42,
  ticket_shirt_admin_corrected_after_operation: 43,
  wristband_linked: 50,
  wristband_replaced: 51,
  wristband_unlinked: 50,
  wristband_blocked: 50,
  store_item_admin_granted: 55,
  order_item_product_confirmed: 55,
  store_order_item_delivered: 56,
  order_item_product_delivered: 56,
  kit_pending: 60,
  ticket_kit_item_delivered: 70,
  participant_kit_item_delivered: 70,
  ticket_checkin_entry: 80,
  participant_checkin_entry: 80,
  combined_kit_delivery_and_checkin: 85,
  ticket_kit_item_delivery_undone: 90,
  store_order_item_delivery_undone: 90,
  ticket_checkin_undo: 91,
  ticket_resent: 92,
  ticket_history_exported: 93,
  admin_ticket_cancelled: 95,
  ticket_cancellation_reclassified: 96,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
  const raw = String(value ?? "").trim();
  return raw && !isUuidLike(raw) ? raw : null;
}

function iso(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function detailsTicketScoped(details: Record<string, unknown>, input: Pick<BuildInput, "ticketId" | "orderId" | "orderItemId">) {
  const ticketId = details.ticket_id ? String(details.ticket_id) : "";
  const orderId = details.order_id ? String(details.order_id) : "";
  const orderItemId = details.order_item_id ? String(details.order_item_id) : "";
  if (ticketId) return ticketId === input.ticketId;
  if (orderItemId) return Boolean(input.orderItemId) && orderItemId === input.orderItemId;
  if (orderId) return Boolean(input.orderId) && orderId === input.orderId;
  return false;
}

function paymentMethodLabel(value: string | null | undefined) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "courtesy") return "Cortesia";
  if (raw === "pix") return "PIX";
  if (raw === "credit_card" || raw === "card" || raw === "creditcard") return "Cartão";
  if (raw === "boleto") return "Boleto";
  return raw.replace(/_/g, " ");
}

function shirtChange(details: Record<string, unknown>) {
  const previous = [text(details.previous_type), text(details.previous_size)].filter(Boolean).join(" ");
  const next = [text(details.next_type), text(details.next_size)].filter(Boolean).join(" ")
    || [text(details.shirt_type), text(details.shirt_size)].filter(Boolean).join(" ");
  if (previous && next) return `${previous} → ${next}`;
  return next || previous || null;
}

function wristbandCode(details: Record<string, unknown>) {
  const code = String(details.code ?? "").trim();
  if (!code) return null;
  return `Código •••${code.slice(-4)}`;
}

function reasonLabel(metadata: Record<string, unknown>) {
  const code = String(metadata.reason_code ?? "").trim();
  if (code && REASON_LABELS[code]) return REASON_LABELS[code];
  return text(metadata.reason_text) ?? text(metadata.reason);
}

function ownerTitle(type: string, metadata: Record<string, unknown> = {}) {
  const reason = String(metadata.reason_code ?? "").trim();
  const hadPreviousOwner = Boolean(metadata.previous_owner_user_id);
  if (type === "owner_transferred") return "Propriedade transferida";
  if (type === "ticket_account_owner_assigned") {
    return hadPreviousOwner ? "Conta proprietária alterada" : "Acesso vinculado à conta";
  }
  if (type === "unassigned_manual_ticket_owner_repaired") return "Propriedade regularizada";
  if (type === "owner_assigned") {
    if (reason === "intended_owner_materialized") return "Proprietário pretendido materializado";
    if (reason === "data_regularization") return "Proprietário materializado";
    if (reason === "administrative_transfer") return hadPreviousOwner ? "Propriedade transferida" : "Acesso vinculado à conta";
    return "Acesso vinculado à conta";
  }
  return ACCOUNT_TITLES[type] ?? "Alteração administrativa";
}

function actorSourceLabel(input: {
  actorUserId?: string | null;
  actorOrigin?: string | null;
  type: string;
  reasonCode?: string | null;
}) {
  const origin = String(input.actorOrigin ?? "").trim();
  if (origin === "portal") return "Titular autenticado";
  if (origin === "import" || input.type.startsWith("imported_") || input.type.startsWith("import_")) return "Importação";
  if (origin === "admin") return "Painel administrativo";
  if (input.actorUserId) {
    if (input.type.includes("owner") && (input.reasonCode === "data_regularization" || input.reasonCode === "intended_owner_materialized")) {
      return null;
    }
    return "Painel administrativo";
  }
  if (
    AUTOMATIC_TYPES.has(input.type)
    || ((ISSUANCE_TYPES.has(input.type) || PAYMENT_TYPES.has(input.type)) && !input.actorUserId)
  ) return "Sistema";
  return null;
}

export function presentAccessTimelineTitle(type: string, metadata: Record<string, unknown> = {}) {
  if (type.includes("owner") || type === "unassigned_manual_ticket_owner_repaired") return ownerTitle(type, metadata);
  return ACCOUNT_TITLES[type] ?? "Alteração administrativa";
}

export function presentAccessTimelineDescription(type: string, metadata: Record<string, unknown>) {
  if (type.includes("shirt") || type === "reservation_expired_released") return shirtChange(metadata);
  if (type === "ticket_category_changed") {
    const previous = text(metadata.previous_category_name) ?? text(metadata.previous_category);
    const next = text(metadata.new_category_name) ?? text(metadata.category_name) ?? text(metadata.next_category);
    if (previous && next) return `${previous} → ${next}`;
    return next || previous;
  }
  if (type.startsWith("holder") || type.includes("holder") || type === "ticket_transferred") {
    const previous = text(metadata.previous_holder_name);
    const next = text(metadata.new_holder_name);
    if (type === "holder_removed") {
      const reason = text(metadata.reason_text) ?? text(metadata.reason);
      return reason ? `Motivo: ${reason}` : previous ? previous : null;
    }
    if (previous && next) return `${previous} → ${next}`;
    return next || previous;
  }
  if (type.includes("owner") || type === "unassigned_manual_ticket_owner_repaired") {
    const previous = text(metadata.previous_owner_name);
    const next = text(metadata.new_owner_name);
    if (previous && next) return `${previous} → ${next}`;
    return reasonLabel(metadata) ?? next ?? previous;
  }
  if (type === "wristband_replaced") {
    const previous = text(metadata.old_wristband_code);
    const next = text(metadata.new_wristband_code);
    const reason = reasonLabel(metadata);
    if (previous && next) return reason ? `${previous} → ${next}. Motivo: ${reason}` : `${previous} → ${next}`;
    return reason;
  }
  if (type.startsWith("wristband_")) return wristbandCode(metadata);
  if (CHECKIN_TYPES.has(type)) {
    const code = text(metadata.wristband_code);
    return code ? `Pulseira utilizada: ${code}` : null;
  }
  if (PAYMENT_TYPES.has(type) || type === "payment_expired") return paymentMethodLabel(text(metadata.payment_method));
  if (ISSUANCE_TYPES.has(type)) return paymentMethodLabel(text(metadata.payment_method)) ?? text(metadata.order_reference);
  if (KIT_ITEM_TYPES.has(type) || type === "combined_kit_delivery_and_checkin") return text(metadata.shirt_label);
  if (type === "ticket_notes_updated") return text(metadata.notes);
  if (type === "cart_coupon_applied") return text(metadata.coupon_code) ?? text(metadata.code);
  const previous = text(metadata.previous_status) ?? text(metadata.previous_state);
  const next = text(metadata.new_status) ?? text(metadata.next_status);
  if (previous && next) return `${previous} → ${next}`;
  if (!ACCOUNT_TITLES[type]) return type;
  return null;
}

function shouldShowStatus(type: string, status: string | null) {
  if (status === "pending") return true;
  if (status === "cancelled" || type.includes("undo") || type.includes("undone") || type.includes("cancelled")) return true;
  return false;
}

function resolveActorName(actorUserId: string | null, operatorNames?: Map<string, string>) {
  if (!actorUserId) return null;
  return text(operatorNames?.get(actorUserId));
}

export function accessTimelineTieRank(type: string) {
  return TIE_RANK[type] ?? 45;
}

export function sortAccessTimelineEvents<T extends { occurredAt: string; type: string; id: string }>(events: T[]) {
  return [...events].sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt)
    || accessTimelineTieRank(b.type) - accessTimelineTieRank(a.type)
    || a.id.localeCompare(b.id),
  );
}

function keepPreferred(events: AccessTimelineEvent[], types: Set<string>, preference: string[]) {
  const matches = events.filter((event) => types.has(event.type));
  if (matches.length <= 1) return events;
  const preferred = preference
    .map((type) => matches.find((event) => event.type === type && event.source === "audit") ?? matches.find((event) => event.type === type))
    .find(Boolean)
    ?? matches.find((event) => event.source === "audit")
    ?? matches[0];
  return events.filter((event) => !types.has(event.type) || event.id === preferred.id);
}

export function deduplicateAccessTimelineEvents(events: AccessTimelineEvent[]) {
  const combined = events.find((event) => event.type === "combined_kit_delivery_and_checkin");
  let next = events;
  if (combined) {
    next = next.filter((event) => event.id === combined.id || (!CHECKIN_TYPES.has(event.type) && !KIT_ITEM_TYPES.has(event.type)));
  } else {
    const kitItems = next.filter((event) => KIT_ITEM_TYPES.has(event.type));
    if (kitItems.length > 1) {
      const kept = [...kitItems].sort((a, b) => {
        if (a.source !== b.source) return a.source === "audit" ? -1 : 1;
        return b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id);
      })[0];
      next = next.filter((event) => !KIT_ITEM_TYPES.has(event.type) || event.id === kept.id);
    }
    next = keepPreferred(next, CHECKIN_TYPES, ["ticket_checkin_entry", "participant_checkin_entry"]);
  }
  next = keepPreferred(next, ISSUANCE_TYPES, [
    "manual_ticket_issued",
    "imported_ticket_issue_finalized",
    "create_imported_order_and_issue_ticket",
    "ticket_issued",
    "manual_registration_order_created",
    "manual_unassigned_ticket_order_created",
  ]);
  next = keepPreferred(next, PAYMENT_TYPES, ["payment_confirmed", "imported_payment_confirmed", "payment_admin_confirmed", "registration_payment_confirmed"]);
  const seen = new Set<string>();
  return next.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

function eventFromAudit(
  row: AccessTimelineAuditRow,
  input: BuildInput,
): AccessTimelineEvent | null {
  const occurredAt = iso(row.created_at);
  const type = String(row.action ?? "").trim();
  if (!occurredAt || !type) return null;
  const details = asRecord(row.details);
  const entityType = String(row.entity_type ?? "");
  if (entityType === "participants" && !detailsTicketScoped(details, input)) return null;
  if (entityType === "orders" && input.orderId && String(row.entity_id ?? "") !== input.orderId) return null;
  if (entityType === "tickets" && String(row.entity_id ?? "") !== input.ticketId && !detailsTicketScoped(details, input)) return null;
  if (entityType === "order_items" && input.orderItemId && String(row.entity_id ?? "") !== input.orderItemId) return null;
  const actorUserId = details.actor_user_id ? String(details.actor_user_id) : null;
  const metadata = {
    ...details,
    order_reference: input.orderReference,
    event_name: input.eventName,
    shirt_label: input.shirtLabel,
    payment_method: details.payment_method ?? input.paymentMethod,
  };
  return {
    id: `audit-${row.id ?? `${type}-${occurredAt}`}`,
    occurredAt,
    type,
    title: presentAccessTimelineTitle(type, metadata),
    description: presentAccessTimelineDescription(type, metadata),
    actorName: resolveActorName(actorUserId, input.operatorNames),
    actorSource: actorSourceLabel({
      actorUserId,
      actorOrigin: details.actor_origin ? String(details.actor_origin) : null,
      type,
      reasonCode: details.reason_code ? String(details.reason_code) : null,
    }),
    source: "audit",
    metadata,
    status: "confirmed",
    showStatus: false,
  };
}

export function buildAccountAccessTimeline(input: BuildInput): AccessTimelineEvent[] {
  const events: AccessTimelineEvent[] = [];
  const issuedAt = iso(input.issuedAt);
  const confirmedAt = iso(input.paidAt ?? input.confirmedAt);
  const usedAt = iso(input.usedAt);
  const kitDeliveredAt = iso(input.kitDeliveredAt);

  if (issuedAt) {
    events.push({
      id: `functional-issued-${input.ticketId}`,
      occurredAt: issuedAt,
      type: "ticket_issued",
      title: presentAccessTimelineTitle("ticket_issued"),
      description: paymentMethodLabel(input.paymentMethod) ?? (input.orderReference ? `Pedido ${input.orderReference}` : null),
      actorName: null,
      actorSource: "Sistema",
      source: "functional",
      metadata: { order_reference: input.orderReference, payment_method: input.paymentMethod },
      status: "confirmed",
      showStatus: false,
    });
  }
  if (confirmedAt) {
    events.push({
      id: `functional-paid-${input.ticketId}`,
      occurredAt: confirmedAt,
      type: "payment_confirmed",
      title: presentAccessTimelineTitle("payment_confirmed"),
      description: paymentMethodLabel(input.paymentMethod),
      actorName: null,
      actorSource: "Sistema",
      source: "functional",
      metadata: { payment_method: input.paymentMethod },
      status: "confirmed",
      showStatus: false,
    });
  }
  if (usedAt) {
    events.push({
      id: `functional-checkin-${input.ticketId}`,
      occurredAt: usedAt,
      type: "ticket_checkin_entry",
      title: presentAccessTimelineTitle("ticket_checkin_entry"),
      description: null,
      actorName: null,
      actorSource: null,
      source: "functional",
      metadata: { event_name: input.eventName },
      status: "used",
      showStatus: false,
    });
  }
  if (input.kitFullyDelivered && kitDeliveredAt) {
    events.push({
      id: `functional-kit-${input.ticketId}`,
      occurredAt: kitDeliveredAt,
      type: "ticket_kit_item_delivered",
      title: presentAccessTimelineTitle("ticket_kit_item_delivered"),
      description: input.shirtLabel ?? null,
      actorName: null,
      actorSource: null,
      source: "functional",
      metadata: { shirt_label: input.shirtLabel },
      status: "confirmed",
      showStatus: false,
    });
  } else if (input.kitFullyDelivered === false && input.confirmedAt) {
    events.push({
      id: `functional-kit-pending-${input.ticketId}`,
      occurredAt: confirmedAt ?? issuedAt ?? new Date(0).toISOString(),
      type: "kit_pending",
      title: "Aguardando retirada do kit",
      description: "Apresente o QR Code no ponto de retirada do Militrin.",
      actorName: null,
      actorSource: null,
      source: "functional",
      metadata: {},
      status: "pending",
      showStatus: true,
    });
  }

  for (const row of input.auditRows ?? []) {
    const event = eventFromAudit(row, input);
    if (event) events.push(event);
  }

  for (const row of input.holderRows ?? []) {
    const occurredAt = iso(row.created_at);
    const type = String(row.operation ?? "").trim();
    if (!occurredAt || !type) continue;
    const actorUserId = row.actor_user_id ? String(row.actor_user_id) : null;
    const metadata = {
      previous_holder_name: row.previous_holder_name,
      new_holder_name: row.new_holder_name,
      reason: row.reason,
      reason_code: row.reason_code,
      reason_text: row.reason_text,
    };
    events.push({
      id: `holder-${row.id ?? `${type}-${occurredAt}`}`,
      occurredAt,
      type,
      title: presentAccessTimelineTitle(type, metadata),
      description: presentAccessTimelineDescription(type, metadata),
      actorName: resolveActorName(actorUserId, input.operatorNames),
      actorSource: actorSourceLabel({
        actorUserId,
        actorOrigin: row.actor_origin ? String(row.actor_origin) : null,
        type,
        reasonCode: row.reason_code ? String(row.reason_code) : null,
      }),
      source: "history",
      metadata,
      status: "confirmed",
      showStatus: false,
    });
  }

  for (const row of input.ownerRows ?? []) {
    const occurredAt = iso(row.created_at);
    const type = String(row.operation ?? "").trim();
    if (!occurredAt || !type) continue;
    const actorUserId = row.actor_user_id ? String(row.actor_user_id) : null;
    const metadata = {
      previous_owner_user_id: row.previous_owner_user_id,
      new_owner_user_id: row.new_owner_user_id,
      previous_owner_name: text(input.operatorNames?.get(String(row.previous_owner_user_id ?? ""))),
      new_owner_name: text(input.operatorNames?.get(String(row.new_owner_user_id ?? ""))),
      reason_code: row.reason_code,
      reason_text: row.reason_text,
    };
    events.push({
      id: `owner-${row.id ?? `${type}-${occurredAt}`}`,
      occurredAt,
      type,
      title: presentAccessTimelineTitle(type, metadata),
      description: presentAccessTimelineDescription(type, metadata),
      actorName: resolveActorName(actorUserId, input.operatorNames),
      actorSource: actorSourceLabel({
        actorUserId,
        actorOrigin: row.actor_origin ? String(row.actor_origin) : null,
        type,
        reasonCode: row.reason_code ? String(row.reason_code) : null,
      }),
      source: "history",
      metadata,
      status: "confirmed",
      showStatus: false,
    });
  }

  const deduped = deduplicateAccessTimelineEvents(events).map((event) => ({
    ...event,
    showStatus: shouldShowStatus(event.type, event.status),
  }));
  return sortAccessTimelineEvents(deduped);
}

export function accessTimelineActorLine(event: Pick<AccessTimelineEvent, "actorName" | "actorSource">) {
  if (event.actorName && event.actorSource) return `Por ${event.actorName} · ${event.actorSource}`;
  if (event.actorName) return `Por ${event.actorName}`;
  if (event.actorSource) return event.actorSource;
  return null;
}

export function collectAccessTimelineActorIds(input: {
  auditRows?: AccessTimelineAuditRow[];
  holderRows?: AccessTimelineHistoryRow[];
  ownerRows?: AccessTimelineHistoryRow[];
}) {
  const ids: string[] = [];
  for (const row of input.auditRows ?? []) {
    const actor = asRecord(row.details).actor_user_id;
    if (actor) ids.push(String(actor));
  }
  for (const row of [...(input.holderRows ?? []), ...(input.ownerRows ?? [])]) {
    for (const value of [row.actor_user_id, row.previous_owner_user_id, row.new_owner_user_id]) {
      if (value) ids.push(String(value));
    }
  }
  return [...new Set(ids)];
}
