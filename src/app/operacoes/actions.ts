"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";
import { revalidatePath } from "next/cache";
import { ticketHasOpenIssueBlock } from "@/lib/account/ticket-operation-blocks";
import type {
  OperationGroup,
  OperationOrderTicketSummary,
  OperationParticipantDetails,
  OperationTicketDetails,
  OperationTicketRow,
  TicketBackedOperationEntry,
  PickupCapabilities,
  PickupEvent,
} from "./types";

type OperationFiltersInput = {
  eventId?: string | null;
  search?: string;
  page?: number;
  pageSize?: number;
};

type RawWristband = {
  id: string;
  code: string;
  status: string;
  linked_at: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function invalidTicketId() {
  return { success: false as const, message: "Identificador de ingresso inválido." };
}

function operationRpcError(error: { message?: string; details?: string | null } | null): {
  code: string;
  message: string;
  shirt_type?: string;
  shirt_size?: string;
  physical_available?: number;
} {
  if (!error) return { code: "OPERATION_FAILED", message: "Operação não concluída." };
  const serialized = `${error.message ?? ""} ${error.details ?? ""}`;
  if (!serialized.includes("SHIRT_OUT_OF_STOCK")) {
    return { code: "OPERATION_FAILED", message: error.message ?? "Operação não concluída." };
  }
  try {
    const detail = JSON.parse(error.details ?? "{}") as { shirt_type?: string; shirt_size?: string; physical_available?: number; message?: string };
    return { code: "SHIRT_OUT_OF_STOCK", shirt_type: detail.shirt_type ?? "Camiseta", shirt_size: detail.shirt_size ?? "", physical_available: Number(detail.physical_available ?? 0), message: detail.message ?? "Camiseta sem estoque. A entrega não foi confirmada." };
  } catch {
    return { code: "SHIRT_OUT_OF_STOCK", shirt_type: "Camiseta", shirt_size: "", physical_available: 0, message: "Não há estoque disponível para esta camiseta. A entrega não foi confirmada." };
  }
}

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function paymentRank(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "paid" || normalized === "confirmed" || normalized === "succeeded") return 0;
  if (normalized === "pending") return 1;
  if (normalized === "processing") return 2;
  return 3;
}

function choosePayment(rows: Array<Record<string, unknown>>): { paymentStatus: string; paymentMethod: string } {
  if (!rows.length) {
    return { paymentStatus: "pending", paymentMethod: "-" };
  }

  const sorted = rows
    .slice()
    .sort((a, b) => {
      const aStatus = String(a.payment_status ?? "pending");
      const bStatus = String(b.payment_status ?? "pending");
      const rank = paymentRank(aStatus) - paymentRank(bStatus);
      if (rank !== 0) return rank;

      const aDate = new Date(String(a.paid_at ?? a.created_at ?? 0)).getTime();
      const bDate = new Date(String(b.paid_at ?? b.created_at ?? 0)).getTime();
      return bDate - aDate;
    });

  return {
    paymentStatus: String(sorted[0]?.payment_status ?? "pending"),
    paymentMethod: String(sorted[0]?.payment_method ?? "-"),
  };
}

function parseTokenCandidate(rawValue: string) {
  const value = rawValue.trim();

  if (!value) return "";

  try {
    const url = new URL(value);
    return url.searchParams.get("token") ?? url.pathname.split("/").filter(Boolean).pop() ?? value;
  } catch {
    return value;
  }
}

function buildOrderTicketIndex(rows: Array<Record<string, unknown>>) {
  const byOrder = new Map<string, Array<{ ticketId: string; sortDate: number }>>();

  for (const row of rows) {
    const orderId = row.order_id ? String(row.order_id) : "";
    const ticketId = String(row.id ?? "");
    if (!orderId || !ticketId) continue;

    const list = byOrder.get(orderId) ?? [];
    list.push({
      ticketId,
      sortDate: new Date(String(row.issued_at ?? 0)).getTime(),
    });
    byOrder.set(orderId, list);
  }

  const index = new Map<string, { position: number; count: number }>();

  for (const [, list] of byOrder) {
    list.sort((a, b) => a.sortDate - b.sortDate);
    const count = list.length;

    list.forEach((item, idx) => {
      index.set(item.ticketId, {
        position: idx + 1,
        count,
      });
    });
  }

  return index;
}

function resolveKitStatus(
  ticketId: string,
  kitMap: Map<string, string[]>,
  applicableItemCount: number,
  queryFailed = false,
): OperationTicketRow["kit_status"] {
  if (queryFailed) return "error";
  // "Não se aplica" exige prova de que não existe item ativo elegível.
  // Ausência de vínculo em participant_kit_items é configuração pendente.
  if (applicableItemCount === 0) return "none";
  const statuses = kitMap.get(ticketId) ?? [];
  if (statuses.length < applicableItemCount) return "configuration_pending";

  const deliveredCount = statuses.filter((status) => status === "delivered").length;
  if (deliveredCount === 0) return "pending";
  if (deliveredCount === statuses.length) return "delivered";
  return "partial";
}

function isConcludedTicket(row: OperationTicketRow, eventHasKit: boolean) {
  if (row.kind !== "ticket") return false;
  if (!eventHasKit) return row.checkin_status === "done";
  return row.checkin_status === "done" && (row.kit_status === "delivered" || row.kit_status === "none");
}

function buildOperationGroups(rows: OperationTicketRow[], eventHasKit: boolean): OperationGroup[] {
  const byKey = new Map<string, OperationGroup>();

  for (const row of rows) {
    const isImported = row.is_imported_without_ticket || row.buyer_type === "imported_holder";
    const groupType: OperationGroup["group_type"] = isImported
      ? "imported_participant"
      : row.order_id
        ? "order"
        : "participant";
    const key = groupType === "order"
      ? `order:${row.order_id}`
      : `${groupType}:${row.participant_id ?? row.id}`;

    let group = byKey.get(key);
    if (!group) {
      group = {
        id: key,
        group_type: groupType,
        order_id: groupType === "order" ? row.order_id : null,
        order_number: groupType === "order" ? row.order_number : null,
        order_created_at: groupType === "order" ? row.order_created_at : null,
        buyer_user_id: groupType === "order" ? row.buyer_user_id : null,
        buyer_name: groupType === "order" ? row.buyer_name : "",
        buyer_cpf: groupType === "order" ? row.buyer_cpf : "",
        buyer_phone: groupType === "order" ? row.buyer_phone : "",
        buyer_email: groupType === "order" ? row.buyer_email : "",
        participant_id: row.participant_id,
        participant_name: row.participant_name,
        ticket_count: 0,
        pending_count: 0,
        completed_count: 0,
        is_imported_without_ticket: row.is_imported_without_ticket,
        tickets: [],
      };
      byKey.set(key, group);
    }

    group.tickets.push(row);
    group.ticket_count += row.kind === "ticket" ? 1 : 0;

    if (row.kind === "ticket" && isConcludedTicket(row, eventHasKit)) {
      group.completed_count += 1;
    } else if (row.kind === "ticket") {
      group.pending_count += 1;
    }
  }

  const groups = Array.from(byKey.values());

  for (const group of groups) {
    group.tickets.sort((a, b) => {
      if (a.is_imported_without_ticket && !b.is_imported_without_ticket) return 1;
      if (!a.is_imported_without_ticket && b.is_imported_without_ticket) return -1;
      if (a.order_ticket_position !== b.order_ticket_position) {
        return a.order_ticket_position - b.order_ticket_position;
      }
      return a.full_name.localeCompare(b.full_name, "pt-BR", { sensitivity: "base" });
    });
  }

  return groups.sort((a, b) => {
    const aOrder = a.group_type === "order";
    const bOrder = b.group_type === "order";
    if (aOrder && !bOrder) return -1;
    if (!aOrder && bOrder) return 1;

    const aDate = new Date(a.order_created_at ?? 0).getTime();
    const bDate = new Date(b.order_created_at ?? 0).getTime();
    if (aDate !== bDate) return bDate - aDate;

    return a.participant_name.localeCompare(b.participant_name, "pt-BR", { sensitivity: "base" });
  });
}

function mapTicketRow(params: {
  row: Record<string, unknown>;
  selectedEvent: Record<string, unknown> | null;
  eventHasKit: boolean;
  eventHasShirt: boolean;
  applicableKitItemCount: number;
  kitQueryFailed?: boolean;
  paymentByOrder: Map<string, { paymentStatus: string; paymentMethod: string }>;
  kitMap: Map<string, string[]>;
  wristbandByTicket: Map<string, RawWristband>;
  orderTicketIndex: Map<string, { position: number; count: number }>;
  participantMap: Map<string, Record<string, unknown>>;
  buyerMap: Map<string, Record<string, unknown>>;
  importedParticipantIds?: Set<string>;
}): TicketBackedOperationEntry {
  const {
    row,
    selectedEvent,
    eventHasKit,
    eventHasShirt,
    applicableKitItemCount,
    kitQueryFailed,
    paymentByOrder,
    kitMap,
    wristbandByTicket,
    orderTicketIndex,
    participantMap,
    buyerMap,
    importedParticipantIds,
  } = params;

  const ticketId = String(row.id ?? "");

  // Resolve order_item (many-to-one via tickets.order_item_id)
  const orderItemRelation = getRelation(
    row.order_items as Record<string, unknown> | Array<Record<string, unknown>> | null,
  ) as Record<string, unknown> | null;

  const orderItemCategory = getRelation(
    orderItemRelation?.ticket_categories as Record<string, unknown> | Array<Record<string, unknown>> | null,
  ) as Record<string, unknown> | null;

  // Participant from tickets.participant_id (batch map, no JOIN filtering)
  const participantRelation: Record<string, unknown> | null =
    row.participant_id ? (participantMap.get(String(row.participant_id)) ?? null) : null;

  // Participant from order_items.participant_id (batch map)
  const orderItemParticipant: Record<string, unknown> | null =
    orderItemRelation?.participant_id
      ? (participantMap.get(String(orderItemRelation.participant_id)) ?? null)
      : null;

  const participantCategory = getRelation(
    participantRelation?.ticket_categories as Record<string, unknown> | Array<Record<string, unknown>> | null,
  ) as Record<string, unknown> | null;

  const participantId = orderItemRelation?.participant_id
    ? String(orderItemRelation.participant_id)
    : orderItemRelation
      ? null
      : row.participant_id
        ? String(row.participant_id)
        : null;

  const participantName = String(
    orderItemParticipant?.full_name ??
      participantRelation?.full_name ??
      "Titular não definido",
  );

  const orderRelation = getRelation(
    row.orders as Record<string, unknown> | Array<Record<string, unknown>> | null,
  ) as Record<string, unknown> | null;
  const buyerUserId = orderRelation?.user_id ? String(orderRelation.user_id) : null;
  const isRegisteredImport = Boolean(participantId && importedParticipantIds?.has(participantId));
  const buyerType = orderRelation?.buyer_type === "imported_holder" || isRegisteredImport
    ? "imported_holder"
    : "account";
  const buyer = buyerUserId ? buyerMap.get(buyerUserId) ?? null : null;

  const cpf = String(participantRelation?.cpf ?? orderItemParticipant?.cpf ?? "");
  const phone = String(participantRelation?.phone ?? orderItemParticipant?.phone ?? "");
  const participantEmail = String(participantRelation?.email ?? orderItemParticipant?.email ?? "");
  const city = String(participantRelation?.city ?? orderItemParticipant?.city ?? "");
  const gender = participantRelation?.gender
    ? String(participantRelation.gender)
    : orderItemParticipant?.gender
      ? String(orderItemParticipant.gender)
      : null;
  const birthDate = participantRelation?.birth_date
    ? String(participantRelation.birth_date)
    : orderItemParticipant?.birth_date
      ? String(orderItemParticipant.birth_date)
      : null;

  const registrationStatus = String(
    participantRelation?.registration_status ?? orderItemParticipant?.registration_status ?? "pending",
  );

  const shirtType = String(orderItemRelation?.shirt_type ?? participantRelation?.shirt_type ?? "");
  const shirtSize = String(orderItemRelation?.shirt_size ?? participantRelation?.shirt_size ?? "");

  const categoryId = orderItemRelation?.ticket_category_id
    ? String(orderItemRelation.ticket_category_id)
    : orderItemCategory?.id
      ? String(orderItemCategory.id)
      : participantCategory?.id
        ? String(participantCategory.id)
        : null;

  const categoryName = String(orderItemCategory?.name ?? participantCategory?.name ?? "Sem categoria");

  const orderId = row.order_id ? String(row.order_id) : null;
  const payment = orderId ? paymentByOrder.get(orderId) : undefined;
  const paymentStatus = payment?.paymentStatus ?? "pending";
  const paymentMethod = payment?.paymentMethod ?? "-";

  const ticketStatus = row.status ? String(row.status) : "pending";
  const ticketUsedAt = row.used_at ? String(row.used_at) : null;
  const ticketIssuedAt = row.issued_at ? String(row.issued_at) : null;
  const checkinStatus = ticketStatus === "used" || ticketUsedAt ? "done" : "pending";

  const kitStatus = resolveKitStatus(ticketId, kitMap, applicableKitItemCount, kitQueryFailed);
  const wristband = wristbandByTicket.get(ticketId) ?? null;

  const blockReason =
    paymentStatus !== "paid"
      ? "Pagamento pendente."
      : registrationStatus === "cancelled"
        ? "Inscrição cancelada."
        : null;

  const ticketIndex = orderTicketIndex.get(ticketId) ?? { position: 1, count: 1 };

  return {
    kind: "ticket" as const,
    id: ticketId,
    ticket_id: ticketId,
    ticket_token: row.token ? String(row.token) : null,
    ticket_status: ticketStatus,
    ticket_used_at: ticketUsedAt,
    ticket_issued_at: ticketIssuedAt,
    participant_id: participantId,
    participant_name: participantName,
    participant_email: participantEmail,
    full_name: participantName,
    cpf,
    phone,
    city,
    gender,
    birth_date: birthDate,
    registration_status: registrationStatus,
    event_id: String(row.event_id ?? ""),
    event_name: String(selectedEvent?.name ?? "Evento"),
    category_id: categoryId,
    category_name: categoryName,
    order_id: orderId,
    order_number: orderRelation?.order_number ? String(orderRelation.order_number) : null,
    order_created_at: orderRelation?.created_at ? String(orderRelation.created_at) : null,
    buyer_user_id: buyerUserId,
    buyer_name: String(buyer?.full_name ?? "Comprador não identificado"),
    buyer_cpf: String(buyer?.cpf ?? ""),
    buyer_phone: String(buyer?.phone ?? ""),
    buyer_email: String(buyer?.email ?? ""),
    buyer_type: buyerType,
    import_batch_id: orderRelation?.import_batch_id ? String(orderRelation.import_batch_id) : null,
    payment_status: paymentStatus,
    payment_method: paymentMethod,
    shirt_type: shirtType,
    shirt_size: shirtSize,
    kit_status: kitStatus,
    checkin_status: checkinStatus,
    wristband_id: wristband?.id ?? null,
    wristband_code: wristband?.code ?? null,
    wristband_status: wristband?.status ?? "none",
    can_operate: blockReason === null,
    block_reason: blockReason,
    order_ticket_count: ticketIndex.count,
    order_ticket_position: ticketIndex.position,
    event_has_kit: eventHasKit,
    event_has_shirt: eventHasShirt,
    event_wristband_enabled: Boolean(selectedEvent?.wristband_enabled),
    event_wristband_required_for_kit: Boolean(selectedEvent?.wristband_required_for_kit),
    event_wristband_required_for_checkin: Boolean(selectedEvent?.wristband_required_for_checkin),
    is_imported_without_ticket: false,
    wristband,
  };
}

export async function getRetiradaCapabilitiesAction() {
  let canDeliverKit = false;
  let canCheckin = false;
  let canChangeShirt = false;

  try {
    await assertPermission("kits.deliver");
    canDeliverKit = true;
  } catch {
    canDeliverKit = false;
  }

  try {
    await assertPermission("checkin.scan");
    canCheckin = true;
  } catch {
    canCheckin = false;
  }

  try {
    await assertPermission("inventory.change_participant_shirt");
    canChangeShirt = true;
  } catch {
    canChangeShirt = false;
  }

  return {
    success: true,
    capabilities: {
      canDeliverKit,
      canCheckin,
      canCombined: canDeliverKit && canCheckin,
      canChangeShirt,
    } satisfies PickupCapabilities,
  };
}

export async function getPickupEventsAction() {
  await assertPermission("participants.view");

  const supabase = await createServerSupabaseClient();

  const [{ data: events, error: eventsError }, { data: kitItems, error: kitItemsError }] =
    await Promise.all([
      supabase
        .from("events")
        .select("id, name, is_active, starts_at, kit_enabled, wristband_enabled, wristband_required_for_kit, wristband_required_for_checkin")
        .order("is_active", { ascending: false })
        .order("starts_at", { ascending: false }),
      supabase
        .from("event_kit_items")
        .select("event_id, item_type, is_active")
        .eq("is_active", true),
    ]);

  if (eventsError) {
    return { success: false as const, message: eventsError.message, events: [] };
  }

  if (kitItemsError) {
    return { success: false as const, message: kitItemsError.message, events: [] };
  }

  const kitByEvent = new Map<string, { hasKit: boolean; hasShirt: boolean }>();

  for (const item of kitItems ?? []) {
    const eventId = String(item.event_id ?? "");
    const current = kitByEvent.get(eventId) ?? { hasKit: false, hasShirt: false };
    current.hasKit = true;

    if (String(item.item_type ?? "").toLowerCase() === "shirt") {
      current.hasShirt = true;
    }

    kitByEvent.set(eventId, current);
  }

  return {
    success: true as const,
    events: (events ?? []).map((event) => {
      const eventId = String(event.id);
      const kit = kitByEvent.get(eventId) ?? {
        hasKit: Boolean(event.kit_enabled),
        hasShirt: false,
      };

      return {
        id: eventId,
        name: String(event.name ?? "Evento"),
        is_active: Boolean(event.is_active),
        starts_at: event.starts_at ? String(event.starts_at) : null,
        has_kit: Boolean(event.kit_enabled) || kit.hasKit,
        has_shirt: kit.hasShirt,
        wristband_enabled: Boolean(event.wristband_enabled),
        wristband_required_for_kit: Boolean(event.wristband_required_for_kit),
        wristband_required_for_checkin: Boolean(event.wristband_required_for_checkin),
      } satisfies PickupEvent;
    }),
  };
}

export async function getKitMaterializationPreviewAction(ticketId: string) {
  if (!isUuid(ticketId)) return invalidTicketId();
  await assertPermission("kits.deliver");
  const supabase = await createServerSupabaseClient();
  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select("id, token, event_id, participant_id, order_items(participant_id,holder_full_name,shirt_type,shirt_size,ticket_category_id,ticket_categories(name))")
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketError || !ticket) return { success: false as const, message: ticketError?.message ?? "Ingresso não encontrado." };

  const orderItem = getRelation(ticket.order_items as Record<string, unknown> | Array<Record<string, unknown>> | null);
  const participantId = orderItem?.participant_id ? String(orderItem.participant_id) : null;

  const [{ data: participant, error: participantError }, { data: eventItems, error: eventItemsError }, { data: links, error: linksError }] = await Promise.all([
    participantId
      ? supabase.from("participants").select("id,full_name,shirt_type,shirt_size,ticket_category_id,ticket_categories(name)").eq("id", participantId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase.from("event_kit_items").select("id,name,item_type,quantity_per_participant,requires_variant").eq("event_id", String(ticket.event_id)).eq("is_active", true).order("sort_order"),
    supabase.from("participant_kit_items").select("id,kit_item_id,status,variant_data").eq("ticket_id", ticketId),
  ]);
  if (participantError) return { success: false as const, message: participantError.message };
  if (eventItemsError) return { success: false as const, message: eventItemsError.message };
  if (linksError) return { success: false as const, message: linksError.message };

  const participantRow = participant as Record<string, unknown> | null;
  const category = getRelation(participantRow?.ticket_categories as Record<string, unknown> | Array<Record<string, unknown>> | null)
    ?? getRelation(orderItem?.ticket_categories as Record<string, unknown> | Array<Record<string, unknown>> | null);
  // LEGACY FALLBACK — do not use as canonical source: participants only covers historical rows without a complete order_item.
  const shirtType = String(orderItem?.shirt_type ?? participantRow?.shirt_type ?? "").trim();
  const shirtSize = String(orderItem?.shirt_size ?? participantRow?.shirt_size ?? "").trim();
  const linkMap = new Map((links ?? []).map((link) => [String(link.kit_item_id), link]));

  return {
    success: true as const,
    preview: {
      participantName: String(participantRow?.full_name ?? orderItem?.holder_full_name ?? "Titular não definido"),
      ticketLabel: String(ticket.token ?? ticket.id),
      categoryName: String(category?.name ?? "Sem categoria"),
      items: (eventItems ?? []).map((item) => {
        const existing = linkMap.get(String(item.id));
        const missingShirtData = String(item.item_type) === "shirt" && (!shirtType || !shirtSize);
        return {
          id: String(item.id), name: String(item.name), itemType: String(item.item_type),
          quantity: Number(item.quantity_per_participant ?? 1),
          state: existing ? "existing" : missingShirtData ? "skipped" : "missing",
          variation: String(item.item_type) === "shirt" && shirtType && shirtSize ? `${shirtType} ${shirtSize}` : null,
          message: missingShirtData ? "Informe modelo e tamanho antes de vincular os itens." : null,
        };
      }),
    },
  };
}

export async function materializeParticipantKitItemsAction(ticketId: string) {
  if (!isUuid(ticketId)) return invalidTicketId();
  await assertPermission("kits.deliver");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("materialize_ticket_kit_items", { p_ticket_id: ticketId });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/operacoes");
  return { success: true as const, message: "Itens vinculados com sucesso.", result: data as Record<string, unknown> };
}

export async function materializeEventParticipantKitItemsAction(eventId: string) {
  await assertPermission("kits.deliver");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("materialize_event_ticket_kit_items", { p_event_id: eventId });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/operacoes");
  return { success: true as const, message: "Regularização concluída.", result: data as Record<string, unknown> };
}

export async function listOperationTicketsAction(filters: OperationFiltersInput = {}) {
  await assertPermission("participants.view");

  const supabase = await createServerSupabaseClient();

  let eventId = filters.eventId?.trim() || null;

  if (!eventId) {
    const { data: activeEvent, error: eventError } = await supabase
      .from("events")
      .select("id")
      .eq("is_active", true)
      .order("starts_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (eventError) {
      return { success: false as const, message: eventError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
    }

    eventId = activeEvent?.id ? String(activeEvent.id) : null;
  }

  if (!eventId) {
    return {
      success: false as const,
      message: "Nenhum evento encontrado.",
      tickets: [] as OperationTicketRow[],
      groups: [] as OperationGroup[],
    };
  }

  const page = Math.max(1, Number(filters.page ?? 1));
  const pageSize = Math.min(500, Math.max(25, Number(filters.pageSize ?? 250)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const [{ data: selectedEvent, error: selectedEventError }, { data: selectedEventKitItems, error: selectedEventKitError }] =
    await Promise.all([
      supabase
        .from("events")
        .select("id, name, kit_enabled, wristband_enabled, wristband_required_for_kit, wristband_required_for_checkin")
        .eq("id", eventId)
        .maybeSingle(),
      supabase
        .from("event_kit_items")
        .select("id, item_type")
        .eq("event_id", eventId)
        .eq("is_active", true),
    ]);

  if (selectedEventError) {
    return { success: false as const, message: selectedEventError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
  }

  if (selectedEventKitError) {
    return { success: false as const, message: selectedEventKitError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
  }

  const eventHasKit = Boolean(selectedEvent?.kit_enabled) || (selectedEventKitItems ?? []).length > 0;
  const eventHasShirt = (selectedEventKitItems ?? []).some(
    (item) => String(item.item_type ?? "").toLowerCase() === "shirt",
  );

  // ── Tickets: SEM embed de participants para evitar INNER JOIN implícito
  // que exclui tickets com participant_id = null (ingressos não atribuídos).
  const { data: ticketRows, error: ticketError, count: totalCount } = await supabase
    .from("tickets")
    .select(
      `
        id,
        token,
        status,
        used_at,
        participant_id,
        event_id,
        order_id,
        issued_at,
        order_items(
          id,
          participant_id,
          holder_full_name,
          shirt_type,
          shirt_size,
          ticket_category_id,
          ticket_categories(id,name)
        ),
        orders(
          id,
          user_id,
          buyer_type,
          import_batch_id,
          created_at,
          order_number
        )
      `,
      { count: "exact" },
    )
    .eq("event_id", eventId)
    .order("issued_at", { ascending: true })
    .range(from, to);

  if (ticketError) {
    return {
      success: false as const,
      message: ticketError.message,
      tickets: [] as OperationTicketRow[],
      groups: [] as OperationGroup[],
    };
  }

  const rows = (ticketRows ?? []) as Array<Record<string, unknown>>;
  const ticketIds = rows.map((row) => String(row.id ?? "")).filter(Boolean);
  const orderIds = Array.from(new Set(rows.map((row) => String(row.order_id ?? "")).filter(Boolean)));
  const buyerUserIds = Array.from(new Set(rows.flatMap((row) => {
    const order = getRelation(row.orders as Record<string, unknown> | Array<Record<string, unknown>> | null);
    return order?.user_id ? [String(order.user_id)] : [];
  })));

  // Coleta participant_ids de duas fontes: tickets.participant_id e order_items.participant_id
  const ticketDirectParticipantIds = Array.from(
    new Set(rows.map((row) => String(row.participant_id ?? "")).filter(Boolean)),
  );
  const orderItemParticipantIds = Array.from(
    new Set(
      rows.flatMap((row) => {
        const oi = getRelation(
          row.order_items as Record<string, unknown> | Array<Record<string, unknown>> | null,
        );
        return oi && (oi as Record<string, unknown>).participant_id
          ? [String((oi as Record<string, unknown>).participant_id)]
          : [];
      }),
    ),
  );
  const allTicketParticipantIds = Array.from(
    new Set([...ticketDirectParticipantIds, ...orderItemParticipantIds]),
  );

  // ── Queries paralelas ────────────────────────────────────────────────────
  const [
    { data: allEventTicketParticipants, error: allEventTicketParticipantsError },
    { data: importedParticipantsRows, error: importedParticipantsError },
    { data: orderItemsParticipantsForEvent, error: oiParticipantsError },
    { data: buyerRows, error: buyerRowsError },
    { data: importedHistoryRows, error: importedHistoryError },
  ] = await Promise.all([
    supabase.from("tickets").select("participant_id").eq("event_id", eventId).not("participant_id", "is", null),
    supabase
      .from("participants")
      .select("id, full_name, cpf, phone, city, gender, birth_date, registration_status, shirt_type, shirt_size, ticket_category_id, ticket_categories(id,name), notes")
      .eq("event_id", eventId)
      .neq("registration_status", "cancelled"),
    // Participantes linked via order_items (mesmo que tickets.participant_id = null)
    orderIds.length
      ? supabase
          .from("order_items")
          .select("participant_id")
          .in("order_id", orderIds)
          .not("participant_id", "is", null)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    buyerUserIds.length
      ? supabase.rpc("get_operation_buyers", { p_event_id: eventId })
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    supabase
      .from("participation_history")
      .select("participant_id")
      .eq("event_id", eventId)
      .eq("source", "import")
      .not("import_batch_id", "is", null)
      .not("participant_id", "is", null),
  ]);

  if (allEventTicketParticipantsError) {
    return { success: false as const, message: allEventTicketParticipantsError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
  }
  if (importedParticipantsError) {
    return { success: false as const, message: importedParticipantsError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
  }
  if (oiParticipantsError) {
    return { success: false as const, message: oiParticipantsError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
  }
  if (buyerRowsError) {
    return { success: false as const, message: buyerRowsError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
  }
  if (importedHistoryError) {
    return { success: false as const, message: importedHistoryError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
  }

  const importedParticipantIds = new Set(
    ((importedHistoryRows ?? []) as Array<Record<string, unknown>>)
      .map((row) => String(row.participant_id ?? ""))
      .filter(Boolean),
  );
  const applicableKitItemCount = (selectedEventKitItems ?? []).length;

  const buyerMap = new Map<string, Record<string, unknown>>();
  for (const buyer of (buyerRows ?? []) as Array<Record<string, unknown>>) {
    const userId = String(buyer.user_id ?? "");
    if (userId) buyerMap.set(userId, buyer);
  }

  // participantsWithTickets inclui tanto tickets.participant_id quanto order_items.participant_id
  const participantsWithTickets = new Set([
    ...((allEventTicketParticipants ?? []) as Array<Record<string, unknown>>)
      .map((row) => String(row.participant_id ?? "")).filter(Boolean),
    ...((orderItemsParticipantsForEvent ?? []) as Array<Record<string, unknown>>)
      .map((row) => String(row.participant_id ?? "")).filter(Boolean),
  ]);

  const fallbackParticipants = ((importedParticipantsRows ?? []) as Array<Record<string, unknown>>).filter((row) => {
    const participantId = String(row.id ?? "");
    if (!participantId) return false;
    if (participantsWithTickets.has(participantId)) return false;
    return true;
  });

  const fallbackParticipantIds = fallbackParticipants.map((row) => String(row.id ?? "")).filter(Boolean);

  // Batch fetch dos participantes (separado do SELECT de tickets para evitar JOIN implícito)
  const allParticipantIdsToFetch = Array.from(
    new Set([...allTicketParticipantIds, ...fallbackParticipantIds]),
  );

  const participantMap = new Map<string, Record<string, unknown>>();
  if (allParticipantIdsToFetch.length > 0) {
    const { data: participantsData } = await supabase
      .from("participants")
      .select("id, full_name, cpf, phone, email, city, gender, birth_date, registration_status, shirt_type, shirt_size, ticket_categories(id,name)")
      .in("id", allParticipantIdsToFetch);

    for (const p of participantsData ?? []) {
      participantMap.set(String((p as Record<string, unknown>).id ?? ""), p as Record<string, unknown>);
    }
  }

  const [{ data: kitRows, error: kitError }, { data: paymentRows, error: paymentError }, { data: wristbandRows, error: wristbandError }, { data: orderTickets, error: orderTicketsError }] =
    await Promise.all([
      ticketIds.length
        ? supabase.from("participant_kit_items").select("ticket_id, kit_item_id, status").in("ticket_id", ticketIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
      orderIds.length
        ? supabase.from("payments").select("order_id, payment_status, payment_method, paid_at, created_at").in("order_id", orderIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
      ticketIds.length
        ? supabase.from("participant_wristbands").select("id, ticket_id, code, status, linked_at").in("ticket_id", ticketIds).eq("status", "active")
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
      orderIds.length
        ? supabase.from("tickets").select("id, order_id, issued_at").in("order_id", orderIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    ]);

  if (paymentError) return { success: false as const, message: paymentError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
  if (wristbandError) return { success: false as const, message: wristbandError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
  if (orderTicketsError) return { success: false as const, message: orderTicketsError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };

  const kitMap = new Map<string, string[]>();
  const applicableKitItemIds = new Set((selectedEventKitItems ?? []).map((item) => String(item.id)));
  for (const row of kitRows ?? []) {
    const ticketId = String((row as Record<string, unknown>).ticket_id ?? "");
    const kitItemId = String((row as Record<string, unknown>).kit_item_id ?? "");
    if (!ticketId || !applicableKitItemIds.has(kitItemId)) continue;
    const list = kitMap.get(ticketId) ?? [];
    list.push(String((row as Record<string, unknown>).status ?? "reserved"));
    kitMap.set(ticketId, list);
  }

  const paymentsByOrder = new Map<string, Array<Record<string, unknown>>>();
  for (const row of paymentRows ?? []) {
    const orderId = String((row as Record<string, unknown>).order_id ?? "");
    if (!orderId) continue;
    const list = paymentsByOrder.get(orderId) ?? [];
    list.push(row as Record<string, unknown>);
    paymentsByOrder.set(orderId, list);
  }

  const paymentByOrder = new Map<string, { paymentStatus: string; paymentMethod: string }>();
  for (const [orderId, rowsByOrder] of paymentsByOrder) {
    paymentByOrder.set(orderId, choosePayment(rowsByOrder));
  }

  const wristbandByTicket = new Map<string, RawWristband>();
  for (const row of wristbandRows ?? []) {
    const ticketId = String((row as Record<string, unknown>).ticket_id ?? "");
    if (!ticketId || wristbandByTicket.has(ticketId)) continue;
    wristbandByTicket.set(ticketId, {
      id: String((row as Record<string, unknown>).id ?? ""),
      code: String((row as Record<string, unknown>).code ?? ""),
      status: String((row as Record<string, unknown>).status ?? "active"),
      linked_at: (row as Record<string, unknown>).linked_at ? String((row as Record<string, unknown>).linked_at) : null,
    });
  }

  const orderTicketIndex = buildOrderTicketIndex((orderTickets ?? []) as Array<Record<string, unknown>>);

  const fallbackPaymentMap = new Map<string, { paymentStatus: string; paymentMethod: string }>();
  if (fallbackParticipantIds.length > 0) {
    const { data: fallbackPayments, error: fallbackPaymentsError } = await supabase
      .from("payments")
      .select("participant_id, payment_status, payment_method, created_at")
      .in("participant_id", fallbackParticipantIds);

    if (fallbackPaymentsError) {
      return { success: false as const, message: fallbackPaymentsError.message, tickets: [] as OperationTicketRow[], groups: [] as OperationGroup[] };
    }

    const rowsByParticipant = new Map<string, Array<Record<string, unknown>>>();
    for (const row of (fallbackPayments ?? []) as Array<Record<string, unknown>>) {
      const participantId = String(row.participant_id ?? "");
      if (!participantId) continue;
      const list = rowsByParticipant.get(participantId) ?? [];
      list.push(row);
      rowsByParticipant.set(participantId, list);
    }

    for (const [participantId, rowsByParticipantId] of rowsByParticipant) {
      fallbackPaymentMap.set(participantId, choosePayment(rowsByParticipantId));
    }
  }

  const mappedRows = rows.map((row) =>
    mapTicketRow({
      row,
      selectedEvent: (selectedEvent as Record<string, unknown> | null) ?? null,
      eventHasKit,
      eventHasShirt,
      applicableKitItemCount,
      kitQueryFailed: Boolean(kitError),
      paymentByOrder,
      kitMap,
      wristbandByTicket,
      orderTicketIndex,
      participantMap,
      buyerMap,
      importedParticipantIds,
    }),
  );

  const fallbackRows: OperationTicketRow[] = fallbackParticipants.map((row) => {
    const participantId = String(row.id ?? "");
    const payment = fallbackPaymentMap.get(participantId);
    const ticketCategory = getRelation(
      row.ticket_categories as Record<string, unknown> | Array<Record<string, unknown>> | null,
    );
    const isImportTagged = importedParticipantIds.has(participantId);

    return {
      kind: "participant_without_ticket" as const,
      id: participantId,
      ticket_id: null,
      ticket_token: null,
      ticket_status: null,
      ticket_used_at: null,
      ticket_issued_at: null,
      participant_id: participantId,
      participant_name: String(row.full_name ?? "Participante importado"),
      participant_email: String(row.email ?? ""),
      full_name: String(row.full_name ?? "Participante importado"),
      cpf: String(row.cpf ?? ""),
      phone: String(row.phone ?? ""),
      city: String(row.city ?? ""),
      gender: row.gender ? String(row.gender) : null,
      birth_date: row.birth_date ? String(row.birth_date) : null,
      registration_status: String(row.registration_status ?? "pending"),
      event_id: eventId,
      event_name: String(selectedEvent?.name ?? "Evento"),
      category_id: row.ticket_category_id ? String(row.ticket_category_id) : null,
      category_name: String(ticketCategory?.name ?? "Sem categoria"),
      order_id: null,
      order_number: null,
      order_created_at: null,
      buyer_user_id: null,
      buyer_name: "",
      buyer_cpf: "",
      buyer_phone: "",
      buyer_email: "",
      buyer_type: isImportTagged ? "imported_holder" : "account",
      import_batch_id: null,
      payment_status: payment?.paymentStatus ?? "pending",
      payment_method: payment?.paymentMethod ?? "-",
      shirt_type: String(row.shirt_type ?? ""),
      shirt_size: String(row.shirt_size ?? ""),
      kit_status: applicableKitItemCount > 0 ? "configuration_pending" : "none",
      checkin_status: "pending",
      wristband_id: null,
      wristband_code: null,
      wristband_status: null,
      can_operate: false,
      block_reason: isImportTagged
        ? "Inscrição importada sem ingresso gerado."
        : "Participante sem ingresso vinculado.",
      order_ticket_count: 0,
      order_ticket_position: 0,
      event_has_kit: eventHasKit,
      event_has_shirt: eventHasShirt,
      event_wristband_enabled: Boolean(selectedEvent?.wristband_enabled),
      event_wristband_required_for_kit: Boolean(selectedEvent?.wristband_required_for_kit),
      event_wristband_required_for_checkin: Boolean(selectedEvent?.wristband_required_for_checkin),
      is_imported_without_ticket: isImportTagged,
      wristband: null,
    };
  });

  const allRows = [...mappedRows, ...fallbackRows];

  const search = normalizeSearch(filters.search ?? "");
  const tickets = (search
    ? allRows.filter((row) => {
        const haystack = normalizeSearch(
          [
            row.participant_name,
            row.participant_email,
            row.cpf,
            row.phone,
            row.buyer_name,
            row.buyer_cpf,
            row.buyer_phone,
            row.buyer_email,
            row.ticket_token,
            row.wristband_code,
            row.order_number,
          ]
            .filter(Boolean)
            .join(" "),
        );
        return haystack.includes(search);
      })
    : allRows
  ).sort((a, b) => a.participant_name.localeCompare(b.participant_name, "pt-BR", { sensitivity: "base" }));

  const groups = buildOperationGroups(tickets, eventHasKit);

  return {
    success: true as const,
    message: null,
    eventId,
    event: {
      id: eventId,
      name: String(selectedEvent?.name ?? "Evento"),
      has_kit: eventHasKit,
      has_shirt: eventHasShirt,
      wristband_enabled: Boolean(selectedEvent?.wristband_enabled),
      wristband_required_for_kit: Boolean(selectedEvent?.wristband_required_for_kit),
      wristband_required_for_checkin: Boolean(selectedEvent?.wristband_required_for_checkin),
    },
    page,
    pageSize,
    total: Number(totalCount ?? tickets.length),
    hasMore: Number(totalCount ?? 0) > to + 1,
    tickets,
    groups,
    participants: tickets,
  };
}

export async function listPickupParticipantsAction(filters: OperationFiltersInput = {}) {
  return listOperationTicketsAction(filters);
}

async function buildTicketDetails(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  ticketId: string,
) {
  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select(
      `
        id,
        token,
        status,
        used_at,
        participant_id,
        event_id,
        order_id,
        issued_at,
        participants(
          id,
          full_name,
          cpf,
          phone,
          city,
          gender,
          birth_date,
          registration_status,
          shirt_type,
          shirt_size,
          ticket_categories(id,name)
        ),
        order_items(
          id,
          participant_id,
          holder_full_name,
          shirt_type,
          shirt_size,
          ticket_category_id,
          participants(
            id,
            full_name,
            cpf,
            phone,
            city,
            gender,
            birth_date,
            registration_status,
            ticket_categories(id,name)
          ),
          ticket_categories(id,name)
        ),
        orders(
          id,
          user_id,
          buyer_type,
          import_batch_id,
          created_at,
          order_number
        ),
        events(
          id,
          name,
          kit_enabled,
          wristband_enabled,
          wristband_required_for_kit,
          wristband_required_for_checkin,
          allow_checkin_during_kit_delivery
        )
      `,
    )
    .eq("id", ticketId)
    .maybeSingle();

  if (ticketError || !ticket?.id) {
    return {
      success: false as const,
      message: ticketError?.message ?? "Ingresso não encontrado.",
    };
  }

  const ticketRow = ticket as Record<string, unknown>;
  const orderId = ticketRow.order_id ? String(ticketRow.order_id) : null;
  const detailOrderItem = getRelation(
    ticketRow.order_items as Record<string, unknown> | Array<Record<string, unknown>> | null,
  );
  const participantId = detailOrderItem?.participant_id
    ? String(detailOrderItem.participant_id)
    : null;

  const { error: ensureKitError } = await supabase.rpc("ensure_ticket_kit_items", { p_ticket_id: ticketId });
  if (ensureKitError) return { success: false as const, message: "Nao foi possivel identificar todos os itens deste ingresso. Revise a camiseta antes da entrega." };

  const [{ data: kitRows, error: kitError }, { data: applicableKitItems, error: applicableKitItemsError }, { data: paymentRows, error: paymentError }, { data: wristbands, error: wristbandError }, { data: orderTicketsRows, error: orderTicketsError }, { data: latestCheckin, error: checkinError }, { data: buyerRows, error: buyerError }] =
    await Promise.all([
      supabase
        .from("participant_kit_items")
        .select("id, kit_item_id, quantity, status, delivered_at, variant_data, event_kit_items(id, name, item_type, shirt_supply_mode)")
        .eq("ticket_id", ticketId),
      supabase
        .from("event_kit_items")
        .select("id, item_type")
        .eq("event_id", String(ticketRow.event_id ?? ""))
        .eq("is_active", true),
      orderId
        ? supabase
            .from("payments")
            .select("order_id, payment_status, payment_method, paid_at, created_at")
            .eq("order_id", orderId)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
      orderId
        ? supabase
            .from("participant_wristbands")
            .select("id, ticket_id, code, status, linked_at")
            .eq("status", "active")
            .in(
              "ticket_id",
              orderId
                ? (
                    (
                      await supabase
                        .from("tickets")
                        .select("id")
                        .eq("order_id", orderId)
                    ).data ?? []
                  ).map((row) => String((row as Record<string, unknown>).id ?? ""))
                : [],
            )
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
      orderId
        ? supabase
            .from("tickets")
            .select(
              `
                id,
                token,
                status,
                participant_id,
                issued_at,
                participants(full_name,shirt_type,shirt_size,ticket_categories(id,name)),
                order_items(participant_id,holder_full_name,shirt_type,shirt_size,participants(id,full_name),ticket_categories(id,name))
              `,
            )
            .eq("order_id", orderId)
            .order("issued_at", { ascending: true })
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
      supabase
        .from("audit_logs")
        .select("id, created_at, details")
        .eq("entity_type", "tickets")
        .eq("entity_id", ticketId)
        .in("action", ["ticket_checkin_entry", "participant_checkin_entry"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.rpc("get_operation_buyers", { p_event_id: String(ticketRow.event_id ?? "") }),
    ]);

  if (kitError) return { success: false as const, message: kitError.message };
  if (applicableKitItemsError) return { success: false as const, message: applicableKitItemsError.message };
  if (paymentError) return { success: false as const, message: paymentError.message };
  if (wristbandError) return { success: false as const, message: wristbandError.message };
  if (orderTicketsError) return { success: false as const, message: orderTicketsError.message };
  if (checkinError) return { success: false as const, message: checkinError.message };
  if (buyerError) return { success: false as const, message: buyerError.message };

  const eventRelation = getRelation(
    ticketRow.events as Record<string, unknown> | Array<Record<string, unknown>> | null,
  );

  const eventHasKit = Boolean(eventRelation?.kit_enabled) || (applicableKitItems ?? []).length > 0;
  const eventHasShirt = (applicableKitItems ?? []).some((item) => String(item.item_type) === "shirt");

  const payment = choosePayment((paymentRows ?? []) as Array<Record<string, unknown>>);

  const kitMap = new Map<string, string[]>();
  if (participantId) {
    kitMap.set(
      participantId,
      ((kitRows ?? []) as Array<Record<string, unknown>>).map((row) => String(row.status ?? "reserved")),
    );
  }

  const wristbandByTicket = new Map<string, RawWristband>();
  for (const row of (wristbands ?? []) as Array<Record<string, unknown>>) {
    const currentTicketId = String(row.ticket_id ?? "");
    if (!currentTicketId || wristbandByTicket.has(currentTicketId)) continue;
    wristbandByTicket.set(currentTicketId, {
      id: String(row.id ?? ""),
      code: String(row.code ?? ""),
      status: String(row.status ?? "active"),
      linked_at: row.linked_at ? String(row.linked_at) : null,
    });
  }

  const orderTicketIndex = buildOrderTicketIndex((orderTicketsRows ?? []) as Array<Record<string, unknown>>);

  // Batch fetch participants for this single ticket detail
  const detailParticipantIds = Array.from(new Set([
    ticketRow.participant_id ? String(ticketRow.participant_id) : null,
    (() => {
      const oi = getRelation(ticketRow.order_items as Record<string, unknown> | Array<Record<string, unknown>> | null);
      return oi && (oi as Record<string, unknown>).participant_id ? String((oi as Record<string, unknown>).participant_id) : null;
    })(),
  ].filter(Boolean) as string[]));

  const detailParticipantMap = new Map<string, Record<string, unknown>>();
  if (detailParticipantIds.length > 0) {
    const { data: detailParticipantsData } = await supabase
      .from("participants")
      .select("id, full_name, cpf, phone, email, city, gender, birth_date, registration_status, shirt_type, shirt_size, registration_contacts(public_pin), ticket_categories(id,name)")
      .in("id", detailParticipantIds);
    for (const p of detailParticipantsData ?? []) {
      detailParticipantMap.set(String((p as Record<string, unknown>).id ?? ""), p as Record<string, unknown>);
    }
  }

  const detailBuyerMap = new Map<string, Record<string, unknown>>();
  for (const buyer of (buyerRows ?? []) as Array<Record<string, unknown>>) {
    const userId = String(buyer.user_id ?? "");
    if (userId) detailBuyerMap.set(userId, buyer);
  }

  const baseRow = mapTicketRow({
    row: ticketRow,
    selectedEvent: {
      id: String(eventRelation?.id ?? ticketRow.event_id ?? ""),
      name: String(eventRelation?.name ?? "Evento"),
      wristband_enabled: Boolean(eventRelation?.wristband_enabled),
      wristband_required_for_kit: Boolean(eventRelation?.wristband_required_for_kit),
      wristband_required_for_checkin: Boolean(eventRelation?.wristband_required_for_checkin),
    },
    eventHasKit,
    eventHasShirt,
    applicableKitItemCount: (applicableKitItems ?? []).length,
    paymentByOrder: new Map(orderId ? [[orderId, payment]] : []),
    kitMap,
    wristbandByTicket,
    orderTicketIndex,
    participantMap: detailParticipantMap,
    buyerMap: detailBuyerMap,
  });

  const orderTickets: OperationOrderTicketSummary[] = ((orderTicketsRows ?? []) as Array<Record<string, unknown>>).map((row) => {
    const participant = getRelation(
      row.participants as Record<string, unknown> | Array<Record<string, unknown>> | null,
    );
    const orderItem = getRelation(
      row.order_items as Record<string, unknown> | Array<Record<string, unknown>> | null,
    );
    // LEGACY FALLBACK — do not use as canonical source: category must come from order_items for all new tickets.
    const category = getRelation(
      (orderItem?.ticket_categories ?? participant?.ticket_categories) as
        | Record<string, unknown>
        | Array<Record<string, unknown>>
        | null,
    );

    const currentTicketId = String(row.id ?? "");
    const wristband = wristbandByTicket.get(currentTicketId) ?? null;

    return {
      ticket_id: currentTicketId,
      ticket_token: row.token ? String(row.token) : null,
      ticket_status: String(row.status ?? "pending"),
      participant_id: orderItem?.participant_id ? String(orderItem.participant_id) : null,
      participant_name: String(
        getRelation(orderItem?.participants as Record<string, unknown> | Array<Record<string, unknown>> | null)?.full_name
          ?? "Titular não definido",
      ),
      category_name: String(category?.name ?? "Sem categoria"),
      // LEGACY FALLBACK — do not use as canonical source: participant shirt fields are historical compatibility only.
      shirt_type: String(orderItem?.shirt_type ?? participant?.shirt_type ?? ""),
      shirt_size: String(orderItem?.shirt_size ?? participant?.shirt_size ?? ""),
      wristband_code: wristband?.code ?? null,
      wristband_status: wristband?.status ?? null,
    };
  });

  const details = latestCheckin?.details && typeof latestCheckin.details === "object" && !Array.isArray(latestCheckin.details)
    ? (latestCheckin.details as Record<string, unknown>)
    : null;

  const lastCheckinActor = details
    ? String(details.actor_email ?? details.actor_user_id ?? details.actor ?? "") || null
    : null;

  const deliveredKitItemIds = ((kitRows ?? []) as Array<Record<string, unknown>>)
    .filter((row) => String(row.status ?? "") === "delivered")
    .map((row) => String(row.id ?? ""))
    .filter(Boolean);
  const deliveredByKitItem = new Map<string, string>();

  if (deliveredKitItemIds.length > 0) {
    const { data: deliveryAudits } = await supabase
      .from("audit_logs")
      .select("entity_id, details, created_at")
      .eq("entity_type", "participant_kit_items")
      .in("action", ["ticket_kit_item_delivered", "participant_kit_item_delivered"])
      .in("entity_id", deliveredKitItemIds)
      .order("created_at", { ascending: false });

    for (const audit of (deliveryAudits ?? []) as Array<Record<string, unknown>>) {
      const itemId = String(audit.entity_id ?? "");
      if (!itemId || deliveredByKitItem.has(itemId)) continue;
      const auditDetails = audit.details && typeof audit.details === "object" && !Array.isArray(audit.details)
        ? audit.details as Record<string, unknown>
        : null;
      deliveredByKitItem.set(itemId, String(auditDetails?.actor_email ?? auditDetails?.actor_user_id ?? "Não informado"));
    }
  }

  const kitItems = ((kitRows ?? []) as Array<Record<string, unknown>>).map((row) => {
    const eki = getRelation(
      row.event_kit_items as Record<string, unknown> | Array<Record<string, unknown>> | null,
    ) as Record<string, unknown> | null;
    const variant = row.variant_data && typeof row.variant_data === "object" && !Array.isArray(row.variant_data)
      ? row.variant_data as Record<string, unknown> : {};
    return {
      kit_item_id: String(row.kit_item_id ?? ""),
      item_name: String(eki?.name ?? "Item"),
      item_type: String(eki?.item_type ?? "item"),
      quantity: Number(row.quantity ?? 1),
      status: String(row.status ?? "reserved"),
      delivered_at: row.delivered_at ? String(row.delivered_at) : null,
      delivered_by: deliveredByKitItem.get(String(row.id ?? "")) ?? null,
      shirt_type: String(eki?.item_type) === "shirt" ? String(variant.shirt_type ?? detailOrderItem?.shirt_type ?? "") || null : null,
      shirt_size: String(eki?.item_type) === "shirt" ? String(variant.shirt_size ?? detailOrderItem?.shirt_size ?? "") || null : null,
      variant_id: variant.variant_id ? String(variant.variant_id) : null,
      supply_mode: String(eki?.shirt_supply_mode ?? ""),
      physical_available: null as number | null,
      stock_status: "not_applicable" as "available" | "last_unit" | "out_of_stock" | "not_applicable",
    };
  });

  const shirtKitItem = kitItems.find((item) => item.item_type === "shirt") ?? null;
  let shirtStock: OperationTicketDetails["shirt_stock"] = null;
  if (shirtKitItem) {
    const { data: stockData, error: stockError } = await supabase.rpc("get_ticket_shirt_stock", { p_ticket_id: ticketId });
    if (stockError) return { success: false as const, message: stockError.message };
    if (stockData && typeof stockData === "object" && !Array.isArray(stockData)) {
      const stock = stockData as Record<string, unknown>;
      const stockStatus = String(stock.status ?? "not_applicable") as "available" | "last_unit" | "out_of_stock" | "not_applicable";
      const physicalAvailable = stock.physical_available == null ? null : Number(stock.physical_available);
      shirtKitItem.physical_available = physicalAvailable;
      shirtKitItem.stock_status = stockStatus;
      shirtStock = { shirt_type: String(stock.shirt_type ?? shirtKitItem.shirt_type ?? "Camiseta"), shirt_size: String(stock.shirt_size ?? shirtKitItem.shirt_size ?? ""), supply_mode: String(stock.supply_mode ?? shirtKitItem.supply_mode), physical_available: physicalAvailable, status: stockStatus };
    }
  }

  const allKitDelivered = kitItems.length > 0 && kitItems.every((item) => item.status === "delivered");

  const participantForLegacy = baseRow.participant_name;

  const [{ data: issuesRows, error: issuesRowsError }, { data: shirtInventoryRows, error: shirtInventoryRowsError }] = await Promise.all([
    participantId
      ? supabase.from("participant_data_issues").select("id,field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery").eq("participant_id", participantId).eq("status", "open")
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    supabase.from("shirt_inventory").select("shirt_type,shirt_size").eq("event_id", String(ticketRow.event_id ?? "")).gt("total_quantity", 0),
  ]);
  if (issuesRowsError) return { success: false as const, message: issuesRowsError.message };
  if (shirtInventoryRowsError) return { success: false as const, message: shirtInventoryRowsError.message };

  const openIssues = ((issuesRows ?? []) as Array<Record<string, unknown>>).map((item) => ({
    id: String(item.id), field_code: String(item.field_code), issue_type: String(item.issue_type), message: String(item.message),
    blocks_payment: Boolean(item.blocks_payment), blocks_ticket_issuance: Boolean(item.blocks_ticket_issuance),
    blocks_checkin: Boolean(item.blocks_checkin), blocks_kit_delivery: Boolean(item.blocks_kit_delivery),
  }));

  const shirtOptionsMap = new Map<string, string[]>();
  for (const item of (shirtInventoryRows ?? []) as Array<Record<string, unknown>>) {
    const type = String(item.shirt_type ?? "");
    const size = String(item.shirt_size ?? "");
    if (!type || !size) continue;
    shirtOptionsMap.set(type, [...(shirtOptionsMap.get(type) ?? []), size]);
  }

  let canFinalizeTicket = false;
  try {
    await assertPermission("finance.confirm_payment");
    canFinalizeTicket = true;
  } catch {
    canFinalizeTicket = false;
  }

  let canIssueTicket = false;
  try {
    await assertPermission("participants.create");
    canIssueTicket = true;
  } catch {
    canIssueTicket = false;
  }

  const registrationContactPin = (() => {
    if (!participantId) return null;
    const relation = detailParticipantMap.get(participantId)?.registration_contacts as Record<string, unknown> | Array<Record<string, unknown>> | null | undefined;
    const contact = Array.isArray(relation) ? relation[0] : relation;
    return contact?.public_pin ? String(contact.public_pin) : null;
  })();

  const participantDetails: OperationTicketDetails = {
    ...baseRow,
    event_kit_enabled: eventHasKit,
    last_checkin_at: latestCheckin?.created_at ? String(latestCheckin.created_at) : baseRow.ticket_used_at,
    last_checkin_actor: lastCheckinActor,
    all_kit_delivered: eventHasKit ? allKitDelivered : true,
    allow_checkin_during_kit_delivery: Boolean(eventRelation?.allow_checkin_during_kit_delivery),
    order_tickets: orderTickets,
    purchase_tickets: orderTickets.map((item) => ({
      ticket_id: item.ticket_id,
      ticket_status: item.ticket_status,
      participant_id: item.participant_id,
      holder_name: item.participant_name,
      shirt_type: item.shirt_type,
      shirt_size: item.shirt_size,
      category_name: item.category_name,
    })),
    kit_items: kitItems,
    full_name: participantForLegacy,
    issues: openIssues,
    shirt_options: Array.from(shirtOptionsMap, ([type, sizes]) => ({ type, sizes: Array.from(new Set(sizes)).sort() })),
    shirt_stock: shirtStock,
    can_finalize_ticket: canFinalizeTicket,
    can_issue_ticket: canIssueTicket,
    registration_contact_pin: registrationContactPin,
  };

  return {
    success: true as const,
    participant: participantDetails,
  };
}

export async function getOperationTicketDetailsAction(ticketId: string) {
  await assertPermission("participants.view");
  if (!isUuid(ticketId)) return invalidTicketId();

  const supabase = await createServerSupabaseClient();
  return buildTicketDetails(supabase, ticketId);
}

export async function getOperationParticipantDetailsAction(participantId: string) {
  await assertPermission("participants.view");
  if (!isUuid(participantId)) return { success: false as const, message: "Identificador de participante inválido." };
  const supabase = await createServerSupabaseClient();
  const { data: participant, error } = await supabase.from("participants")
    .select("id,event_id,organization_id,full_name,email,cpf,phone,city,gender,birth_date,registration_status,shirt_type,shirt_size,ticket_category_id,batch_id,registration_contacts(public_pin),events(id,name,kit_enabled,wristband_enabled,wristband_required_for_kit,wristband_required_for_checkin),ticket_categories(id,name)")
    .eq("id", participantId).maybeSingle();
  if (error || !participant?.id) return { success: false as const, message: error?.message ?? "Participante não encontrado." };

  const [{ data: tickets }, { data: payments, error: paymentError }, { data: history, error: historyError }, { data: issues, error: issuesError }, { data: legacyItems, error: legacyError }, { data: orders, error: ordersError }, { data: shirtInventory, error: shirtInventoryError }, { data: eventCategories, error: eventCategoriesError }, { data: eventBatches, error: eventBatchesError }] = await Promise.all([
    supabase.from("tickets").select("id").eq("participant_id", participantId).limit(1),
    supabase.from("payments").select("id,payment_status,payment_method,amount,final_amount,created_at").eq("participant_id", participantId),
    supabase.from("participation_history").select("source,import_batch_id,status").eq("participant_id", participantId).eq("event_id", String(participant.event_id)),
    supabase.from("participant_data_issues").select("id,field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery").eq("participant_id", participantId).eq("status", "open"),
    supabase.from("participant_kit_items").select("id,status,delivered_at,legacy_unresolved,event_kit_items(name)").eq("participant_id", participantId),
    supabase.from("orders").select("id,buyer_type,import_batch_id,status").eq("participant_id", participantId).eq("event_id", String(participant.event_id)),
    supabase.from("shirt_inventory").select("shirt_type,shirt_size").eq("event_id", String(participant.event_id)).gt("total_quantity", 0),
    supabase.from("ticket_categories").select("id,name").eq("event_id", String(participant.event_id)).eq("is_active", true).order("sort_order"),
    supabase.from("registration_batches").select("id,name,sequence_number").eq("event_id", String(participant.event_id)).order("sequence_number"),
  ]);
  const queryError = paymentError ?? historyError ?? issuesError ?? legacyError ?? ordersError ?? shirtInventoryError ?? eventCategoriesError ?? eventBatchesError;
  if (queryError) return { success: false as const, message: queryError.message };
  if ((tickets ?? []).length) return { success: false as const, message: "Este participante já possui ingresso; atualize a lista." };

  const row = participant as Record<string, unknown>;
  const event = getRelation(row.events as Record<string, unknown> | Array<Record<string, unknown>> | null);
  const category = getRelation(row.ticket_categories as Record<string, unknown> | Array<Record<string, unknown>> | null);
  const registrationContact = getRelation(row.registration_contacts as Record<string, unknown> | Array<Record<string, unknown>> | null);
  const payment = choosePayment((payments ?? []) as Array<Record<string, unknown>>);
  const importBatchIds = Array.from(new Set(((history ?? []) as Array<Record<string, unknown>>).flatMap((item) => item.import_batch_id ? [String(item.import_batch_id)] : [])));
  const openIssues = ((issues ?? []) as Array<Record<string, unknown>>).map((item) => ({ id: String(item.id), field_code: String(item.field_code), issue_type: String(item.issue_type), message: String(item.message), blocks_payment: Boolean(item.blocks_payment), blocks_ticket_issuance: Boolean(item.blocks_ticket_issuance), blocks_checkin: Boolean(item.blocks_checkin), blocks_kit_delivery: Boolean(item.blocks_kit_delivery) }));
  const onlyPayment = (payments ?? []).length === 1 ? (payments?.[0] as Record<string, unknown>) : null;
  const canRegularize = importBatchIds.length === 1 && row.ticket_category_id != null && row.batch_id != null
    && onlyPayment?.amount != null && onlyPayment.final_amount != null && (orders ?? []).length <= 1
    && !openIssues.some((issue) => issue.blocks_ticket_issuance);
  const regularizationBlockers: string[] = [];
  if (row.ticket_category_id == null) regularizationBlockers.push("Categoria do ingresso não atribuída.");
  if (row.batch_id == null) regularizationBlockers.push("Lote de inscrição não atribuído.");
  if ((payments ?? []).length === 0) regularizationBlockers.push("Nenhum pagamento encontrado para esta inscrição.");
  else if ((payments ?? []).length > 1) regularizationBlockers.push("Mais de um pagamento encontrado para esta inscrição.");
  else if (onlyPayment?.amount == null || onlyPayment?.final_amount == null) regularizationBlockers.push("Pagamento sem valores definidos.");
  if ((orders ?? []).length > 1) regularizationBlockers.push("Mais de um pedido associado a esta inscrição.");
  if (importBatchIds.length > 1) regularizationBlockers.push("Mais de um lote de importação associado a esta inscrição.");
  if (openIssues.some((issue) => issue.blocks_ticket_issuance)) regularizationBlockers.push("Existe pendência cadastral que bloqueia a emissão do ingresso — resolva em \"Revisar pendências\".");
  const hasLegacyUnresolved = ((legacyItems ?? []) as Array<Record<string, unknown>>).some((item) => Boolean(item.legacy_unresolved));
  const shirtOptionsMap = new Map<string, string[]>();
  for (const item of (shirtInventory ?? []) as Array<Record<string, unknown>>) {
    const type = String(item.shirt_type ?? "");
    const size = String(item.shirt_size ?? "");
    if (!type || !size) continue;
    shirtOptionsMap.set(type, [...(shirtOptionsMap.get(type) ?? []), size]);
  }
  const withoutTicketClass: OperationParticipantDetails["without_ticket_class"] = hasLegacyUnresolved
    ? "legacy_unresolved"
    : importBatchIds.length === 1 && openIssues.length > 0
      ? "data_pending_import"
      : canRegularize
        ? "regularizable"
        : "manual_review";
  let canFinalizeTicket = false;
  try {
    await assertPermission("finance.confirm_payment");
    canFinalizeTicket = true;
  } catch {
    canFinalizeTicket = false;
  }
  let canIssueTicket = false;
  try {
    await assertPermission("participants.create");
    canIssueTicket = true;
  } catch {
    canIssueTicket = false;
  }
  const details: OperationParticipantDetails = {
    kind: "participant_without_ticket", id: participantId, ticket_id: null, ticket_token: null, ticket_status: null, ticket_used_at: null, ticket_issued_at: null,
    participant_id: participantId, participant_name: String(row.full_name ?? "Participante"), participant_email: String(row.email ?? ""), full_name: String(row.full_name ?? "Participante"),
    cpf: String(row.cpf ?? ""), phone: String(row.phone ?? ""), city: String(row.city ?? ""), gender: row.gender ? String(row.gender) : null, birth_date: row.birth_date ? String(row.birth_date) : null,
    registration_status: String(row.registration_status ?? "pending"), event_id: String(row.event_id), event_name: String(event?.name ?? "Evento"), category_id: row.ticket_category_id ? String(row.ticket_category_id) : null,
    category_name: String(category?.name ?? "Sem categoria"), order_id: null, order_number: null, order_created_at: null, buyer_user_id: null, buyer_name: "", buyer_cpf: "", buyer_phone: "", buyer_email: "",
    buyer_type: importBatchIds.length ? "imported_holder" : "account", import_batch_id: importBatchIds[0] ?? null, payment_status: payment.paymentStatus, payment_method: payment.paymentMethod,
    shirt_type: String(row.shirt_type ?? ""), shirt_size: String(row.shirt_size ?? ""), kit_status: (legacyItems ?? []).length ? "pending" : "configuration_pending", checkin_status: "pending",
    wristband_id: null, wristband_code: null, wristband_status: null, can_operate: false, block_reason: "Esta inscrição não possui vínculo comprovável com um ingresso.", order_ticket_count: 0, order_ticket_position: 0,
    event_has_kit: Boolean(event?.kit_enabled), event_has_shirt: Boolean(row.shirt_type || row.shirt_size), event_wristband_enabled: Boolean(event?.wristband_enabled),
    event_wristband_required_for_kit: Boolean(event?.wristband_required_for_kit), event_wristband_required_for_checkin: Boolean(event?.wristband_required_for_checkin), is_imported_without_ticket: importBatchIds.length > 0, wristband: null,
    origin: importBatchIds.length ? "import" : "registration", import_batch_ids: importBatchIds, issues: openIssues,
    without_ticket_class: withoutTicketClass,
    organization_id: String(row.organization_id ?? ""),
    payment_id: onlyPayment?.id ? String(onlyPayment.id) : null,
    can_finalize_ticket: canFinalizeTicket,
    can_issue_ticket: canIssueTicket,
    registration_contact_pin: registrationContact?.public_pin ? String(registrationContact.public_pin) : null,
    shirt_options: Array.from(shirtOptionsMap, ([type, sizes]) => ({ type, sizes: Array.from(new Set(sizes)).sort() })),
    legacy_kit_items: ((legacyItems ?? []) as Array<Record<string, unknown>>).map((item) => ({ id: String(item.id), item_name: String(getRelation(item.event_kit_items as Record<string, unknown> | Array<Record<string, unknown>> | null)?.name ?? "Item"), status: String(item.status ?? "reserved"), delivered_at: item.delivered_at ? String(item.delivered_at) : null, legacy_unresolved: Boolean(item.legacy_unresolved) })),
    no_ticket_reason: hasLegacyUnresolved ? "Legado sem ingresso" : "Nenhum ingresso foi emitido para esta inscrição.", can_regularize_ticket: canRegularize,
    regularization_reason: canRegularize ? "Há evidência determinística para revisão da regularização." : "A regularização exige revisão manual das evidências cadastrais e financeiras.",
    regularization_blockers: regularizationBlockers,
    batch_id: row.batch_id ? String(row.batch_id) : null,
    event_categories: ((eventCategories ?? []) as Array<Record<string, unknown>>).map((item) => ({ id: String(item.id), name: String(item.name ?? "Categoria") })),
    event_batches: ((eventBatches ?? []) as Array<Record<string, unknown>>).map((item) => ({ id: String(item.id), name: String(item.name ?? "Lote") })),
  };
  return { success: true as const, participant: details };
}

export async function getEventCategoriesAndBatchesAction(eventId: string) {
  await assertPermission("participants.view");
  if (!isUuid(eventId)) return { success: false as const, message: "Evento inválido." };
  const supabase = await createServerSupabaseClient();
  const [{ data: categories, error: categoriesError }, { data: batches, error: batchesError }] = await Promise.all([
    supabase.from("ticket_categories").select("id,name").eq("event_id", eventId).eq("is_active", true).order("sort_order"),
    supabase.from("registration_batches").select("id,name,sequence_number").eq("event_id", eventId).order("sequence_number"),
  ]);
  if (categoriesError) return { success: false as const, message: categoriesError.message };
  if (batchesError) return { success: false as const, message: batchesError.message };
  return {
    success: true as const,
    categories: (categories ?? []).map((item) => ({ id: String(item.id), name: String(item.name) })),
    batches: (batches ?? []).map((item) => ({ id: String(item.id), name: String(item.name) })),
  };
}

export async function assignParticipantCategoryAndBatchAction(input: { participantId: string; eventId: string; categoryId: string; batchId: string }) {
  await assertPermission("participants.edit_basic");
  if (!isUuid(input.participantId) || !isUuid(input.eventId) || !isUuid(input.categoryId) || !isUuid(input.batchId)) {
    return { success: false as const, message: "Selecione categoria e lote." };
  }

  const supabase = await createServerSupabaseClient();
  const [{ count: categoryCount }, { count: batchCount }, { count: priceCount }] = await Promise.all([
    supabase.from("ticket_categories").select("id", { count: "exact", head: true }).eq("id", input.categoryId).eq("event_id", input.eventId).eq("is_active", true),
    supabase.from("registration_batches").select("id", { count: "exact", head: true }).eq("id", input.batchId).eq("event_id", input.eventId),
    supabase.from("registration_batch_prices").select("id", { count: "exact", head: true }).eq("batch_id", input.batchId).eq("ticket_category_id", input.categoryId),
  ]);
  if (!categoryCount) return { success: false as const, message: "Categoria inválida para este evento." };
  if (!batchCount) return { success: false as const, message: "Lote inválido para este evento." };
  if (!priceCount) return { success: false as const, message: "Este lote não tem preço configurado para a categoria escolhida. Configure o preço em Lotes antes de atribuir." };

  const { error } = await supabase.from("participants")
    .update({ ticket_category_id: input.categoryId, batch_id: input.batchId, updated_at: new Date().toISOString() })
    .eq("id", input.participantId).eq("event_id", input.eventId);
  if (error) return { success: false as const, message: error.message };

  revalidatePath("/operacoes");
  return { success: true as const, message: "Categoria e lote atribuídos com sucesso." };
}

export async function getPickupParticipantDetailsAction(ticketOrParticipantId: string) {
  await assertPermission("participants.view");

  const supabase = await createServerSupabaseClient();

  const { data: ticket } = await supabase
    .from("tickets")
    .select("id")
    .eq("id", ticketOrParticipantId)
    .maybeSingle();

  if (ticket?.id) {
    return buildTicketDetails(supabase, String(ticket.id));
  }

  const { data: fallbackTickets, error: fallbackError } = await supabase
    .from("tickets")
    .select("id")
    .eq("participant_id", ticketOrParticipantId)
    .limit(2);

  if (fallbackError) return { success: false as const, message: fallbackError.message };
  if ((fallbackTickets ?? []).length > 1) {
    return { success: false as const, message: "Este participante possui mais de um ingresso. Selecione o ingresso explicitamente." };
  }
  const fallbackTicket = fallbackTickets?.[0];
  if (!fallbackTicket?.id) {
    return { success: false as const, message: "Ingresso não encontrado para este participante." };
  }

  return buildTicketDetails(supabase, String(fallbackTicket.id));
}

export async function searchPickupParticipantAction(query: string) {
  await assertPermission("participants.view");

  const supabase = await createServerSupabaseClient();
  const q = query.trim();

  if (!q) {
    return {
      success: false as const,
      message: "Informe nome, CPF, telefone, token ou código da pulseira.",
    };
  }

  const tokenCandidate = parseTokenCandidate(q);

  const [{ data: participantTickets }, { data: tokenTicket }, { data: wristband }] = await Promise.all([
    supabase
      .from("tickets")
      .select("id,event_id,status,events(name),order_items(ticket_categories(name)),participants(full_name,cpf,phone)")
      .or(`participants.full_name.ilike.%${q}%,participants.cpf.ilike.%${q}%,participants.phone.ilike.%${q}%`)
      .limit(25),
    supabase
      .from("tickets")
      .select("id")
      .eq("token", tokenCandidate)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("participant_wristbands")
      .select("ticket_id")
      .ilike("code", tokenCandidate)
      .eq("status", "active")
      .limit(1)
      .maybeSingle(),
  ]);

  const directTicketId =
    tokenTicket?.id
      ? String(tokenTicket.id)
      : wristband?.ticket_id
        ? String(wristband.ticket_id)
        : null;

  if (directTicketId) return getOperationTicketDetailsAction(directTicketId);
  if ((participantTickets ?? []).length > 1) {
    return {
      success: false as const,
      requires_selection: true as const,
      message: "Mais de um ingresso elegível foi encontrado. Selecione o ingresso explicitamente.",
      tickets: (participantTickets ?? []).map((row) => ({
        ticket_id: String(row.id),
        event_id: String(row.event_id),
        status: String(row.status ?? "pending"),
        event_name: String(getRelation(row.events as Record<string, unknown> | Array<Record<string, unknown>> | null)?.name ?? "Evento"),
        category_name: String(getRelation(getRelation(row.order_items as Record<string, unknown> | Array<Record<string, unknown>> | null)?.ticket_categories as Record<string, unknown> | Array<Record<string, unknown>> | null)?.name ?? "Sem categoria"),
      })),
    };
  }
  const matchedTicketId = participantTickets?.[0]?.id ? String(participantTickets[0].id) : null;
  if (!matchedTicketId) {
    return {
      success: false as const,
      message: "Nenhum ingresso encontrado.",
    };
  }

  return getOperationTicketDetailsAction(matchedTicketId);
}

export async function searchPickupParticipantByQrAction(rawValue: string) {
  await assertPermission("participants.view");

  const supabase = await createServerSupabaseClient();
  const tokenCandidate = parseTokenCandidate(rawValue);

  if (!tokenCandidate) {
    return { success: false as const, message: "QR Code vazio." };
  }

  const { data: ticket, error } = await supabase
    .from("tickets")
    .select("id")
    .eq("token", tokenCandidate)
    .limit(1)
    .maybeSingle();

  if (error || !ticket?.id) {
    return {
      success: false as const,
      message: error?.message ?? "Ingresso não encontrado para este QR Code.",
    };
  }

  return getOperationTicketDetailsAction(String(ticket.id));
}

export async function deliverKitItemAction(payload: { ticket_id: string; kit_item_id: string }) {
  await assertPermission("kits.deliver");
  if (!isUuid(payload.ticket_id)) return invalidTicketId();
  const supabase = await createServerSupabaseClient();
  const issueBlock = await ticketHasOpenIssueBlock(supabase, payload.ticket_id, "blocks_kit_delivery");
  if (issueBlock.error || issueBlock.blocked) return { success: false, message: "Entrega bloqueada por pendência do cadastro." };
  const { error } = await supabase.rpc("deliver_ticket_kit_item", {
    p_ticket_id: payload.ticket_id,
    p_kit_item_id: payload.kit_item_id,
  });

  if (error) {
    return { success: false, ...operationRpcError(error) };
  }

  return { success: true, message: "Item entregue com sucesso." };
}

export async function deliverFullKitAction(payload: { ticket_id: string }) {
  await assertPermission("kits.deliver");
  if (!isUuid(payload.ticket_id)) return invalidTicketId();
  const supabase = await createServerSupabaseClient();
  const issueBlock = await ticketHasOpenIssueBlock(supabase, payload.ticket_id, "blocks_kit_delivery");
  if (issueBlock.error || issueBlock.blocked) return { success: false, message: "Entrega bloqueada por pendência do cadastro." };
  const { data: pendingItems, error: pendingItemsError } = await supabase
    .from("participant_kit_items")
    .select("id")
    .eq("ticket_id", payload.ticket_id)
    .neq("status", "delivered")
    .limit(1);

  if (pendingItemsError) {
    return { success: false, message: pendingItemsError.message };
  }

  if ((pendingItems ?? []).length === 0) {
    return { success: false, message: "Kit já foi entregue anteriormente." };
  }

  const { error } = await supabase.rpc("deliver_ticket_full_kit", {
    p_ticket_id: payload.ticket_id,
  });

  if (error) {
    return { success: false, ...operationRpcError(error) };
  }

  revalidatePath("/operacoes");
  revalidatePath(`/ingressos/${payload.ticket_id}`);
  return { success: true, message: "Kit completo entregue com sucesso." };
}

export async function undoFullKitDeliveryAction(payload: { ticket_id: string }) {
  await assertPermission("kits.undo_delivery");
  if (!isUuid(payload.ticket_id)) return invalidTicketId();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("undo_ticket_full_kit", {
    p_ticket_id: payload.ticket_id,
  });
  if (error || data !== true) return { success: false, message: error?.message ?? "Não foi possível reverter a entrega do kit." };
  revalidatePath("/operacoes");
  revalidatePath(`/ingressos/${payload.ticket_id}`);
  return { success: true, message: "Entrega do kit revertida com sucesso." };
}

export async function changeShirtAction(payload: { ticketId: string; shirtType: string; shirtSize: string }) {
  await assertPermission("inventory.change_participant_shirt");
  if (!isUuid(payload.ticketId)) return invalidTicketId();
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("admin_change_ticket_shirt", {
    p_ticket_id: payload.ticketId,
    p_new_shirt_type: payload.shirtType,
    p_new_shirt_size: payload.shirtSize,
  });
  if (error) return { success: false, message: error.message };
  revalidatePath("/operacoes");
  return { success: true, message: "Camiseta alterada com sucesso." };
}

export async function checkinEntryAction(payload: { ticket_id: string }) {
  await assertPermission("checkin.scan");
  if (!isUuid(payload.ticket_id)) return invalidTicketId();

  const supabase = await createServerSupabaseClient();
  const issueBlock = await ticketHasOpenIssueBlock(supabase, payload.ticket_id, "blocks_checkin");
  if (issueBlock.error || issueBlock.blocked) return { success: false, message: "Check-in bloqueado por pendência do cadastro." };

  const ticketId = payload.ticket_id;

  if (!ticketId) {
    return { success: false, message: "Ingresso não encontrado para check-in." };
  }

  const { data, error } = await supabase.rpc("checkin_ticket_entry", {
    p_ticket_id: ticketId,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  if (data !== true) {
    return { success: false, message: "Não foi possível registrar a entrada do ingresso." };
  }

  revalidatePath("/operacoes");
  revalidatePath(`/ingressos/${ticketId}`);
  return {
    success: true,
    message: `Entrada confirmada para o ingresso ${ticketId}.`,
  };
}

export async function undoCheckinEntryAction(payload: { ticket_id: string }) {
  await assertPermission("checkin.undo");
  if (!isUuid(payload.ticket_id)) return invalidTicketId();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("undo_ticket_checkin", {
    p_ticket_id: payload.ticket_id,
  });
  if (error || data !== true) return { success: false, message: error?.message ?? "Não foi possível desfazer o check-in." };
  revalidatePath("/operacoes");
  revalidatePath(`/ingressos/${payload.ticket_id}`);
  return { success: true, message: "Check-in desfeito com sucesso." };
}

export async function deliverKitAndCheckinAction(payload: { ticket_id: string }) {
  await assertPermission("kits.deliver");
  await assertPermission("checkin.scan");
  if (!isUuid(payload.ticket_id)) return invalidTicketId();

  const supabase = await createServerSupabaseClient();
  const [kitBlock, checkinBlock] = await Promise.all([
    ticketHasOpenIssueBlock(supabase, payload.ticket_id, "blocks_kit_delivery"),
    ticketHasOpenIssueBlock(supabase, payload.ticket_id, "blocks_checkin"),
  ]);
  if (kitBlock.error || checkinBlock.error || kitBlock.blocked || checkinBlock.blocked) return { success: false, message: "Operação bloqueada por pendência específica de entrega ou check-in.", kit_delivered: false, checkin_done: false };

  const { data: combinedData, error: combinedError } = await supabase.rpc("deliver_items_and_checkin", {
    p_ticket_id: payload.ticket_id,
  });

  if (combinedError || combinedData !== true) {
    const parsedError = operationRpcError(combinedError);
    return {
      success: false,
      ...parsedError,
      kit_delivered: false,
      checkin_done: false,
    };
  }

  revalidatePath("/operacoes");
  revalidatePath(`/ingressos/${payload.ticket_id}`);
  return {
    success: true,
    message: "Itens entregues e entrada confirmada.",
    kit_delivered: true,
    checkin_done: true,
  };
}
