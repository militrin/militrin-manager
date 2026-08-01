"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";

export async function getRetiradaCapabilitiesAction() {
  let canDeliverKit = false;
  let canCheckin = false;

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

  return {
    success: true,
    capabilities: {
      canDeliverKit,
      canCheckin,
      canCombined: canDeliverKit && canCheckin,
    },
  };
}


type PickupFilters = {
  eventId?: string | null;
  search?: string;
};

type PickupListItem = {
  id: string;
  event_id: string;
  full_name: string;
  cpf: string;
  phone: string;
  city: string;
  gender: string | null;
  birth_date: string | null;
  payment_status: string;
  payment_method: string;
  registration_status: string;
  shirt_type: string;
  shirt_size: string;
  category_name: string;
  event_name: string;
  ticket_id: string | null;
  ticket_status: string | null;
  ticket_used_at: string | null;
  kit_status: "none" | "pending" | "partial" | "delivered";
  checkin_status: "pending" | "done";
  can_operate: boolean;
  block_reason: string | null;
  event_has_kit: boolean;
  event_has_shirt: boolean;
  event_wristband_enabled: boolean;
  event_wristband_required_for_kit: boolean;
  event_wristband_required_for_checkin: boolean;
  wristband: {
    id: string;
    code: string;
    status: string;
    linked_at: string | null;
  } | null;
};

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

async function getLatestPayment(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  participantId: string,
) {
  const { data, error } = await supabase.rpc("get_participant_payment_details", {
    p_participant_id: participantId,
  });

  if (error) {
    return {
      error,
      paymentStatus: "pending",
      paymentMethod: "-",
    };
  }

  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;

  return {
    error: null,
    paymentStatus: String(row?.payment_status ?? "pending"),
    paymentMethod: String(row?.payment_method ?? "-"),
  };
}

async function buildPickupDetails(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  participantId: string,
) {
  const { data, error } = await supabase
    .from("participants")
    .select(`
      id,
      event_id,
      full_name,
      cpf,
      phone,
      city,
      gender,
      birth_date,
      registration_status,
      shirt_type,
      shirt_size,
      events(
        name,
        kit_enabled,
        wristband_enabled,
        wristband_required_for_kit,
        wristband_required_for_checkin,
        allow_checkin_during_kit_delivery
      ),
      ticket_categories(name)
    `)
    .eq("id", participantId)
    .maybeSingle();

  if (error || !data) {
    return {
      success: false as const,
      message: error?.message ?? "Participante não encontrado.",
    };
  }

  const [
    { data: kitItemsData, error: kitItemsError },
    payment,
    { data: ticketData, error: ticketError },
    { data: checkinLogData, error: checkinLogError },
  ] = await Promise.all([
    supabase.rpc("get_participant_kit_items", {
      p_participant_id: participantId,
    }),
    getLatestPayment(supabase, participantId),
    supabase
      .from("tickets")
      .select("id, token, status, used_at, order_id")
      .eq("participant_id", participantId)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("audit_logs")
      .select("id, created_at, details")
      .eq("entity_type", "participants")
      .eq("entity_id", participantId)
      .eq("action", "participant_checkin_entry")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  let wristbandData:
    | {
        id: string;
        code: string;
        status: string;
        linked_at: string | null;
      }
    | null = null;

  if (ticketData?.id) {
    const { data: activeWristband, error: wristbandError } = await supabase
      .from("participant_wristbands")
      .select("id, code, status, linked_at")
      .eq("ticket_id", String(ticketData.id))
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (wristbandError) {
      return { success: false as const, message: wristbandError.message };
    }

    wristbandData = activeWristband
      ? {
          id: String(activeWristband.id),
          code: String(activeWristband.code ?? ""),
          status: String(activeWristband.status ?? "active"),
          linked_at: activeWristband.linked_at ? String(activeWristband.linked_at) : null,
        }
      : null;
  }

  let purchaseTickets: Array<{
    ticket_id: string;
    ticket_status: string;
    participant_id: string | null;
    holder_name: string;
    shirt_type: string;
    shirt_size: string;
    category_name: string;
  }> = [];

  if (ticketData?.order_id) {
    const { data: orderTickets, error: orderTicketsError } = await supabase
      .from("tickets")
      .select(`
        id,
        status,
        participant_id,
        order_items(
          holder_full_name,
          shirt_type,
          shirt_size,
          participants(full_name),
          ticket_categories(name)
        ),
        participants(
          full_name,
          shirt_type,
          shirt_size,
          ticket_categories(name)
        )
      `)
      .eq("order_id", String(ticketData.order_id))
      .order("issued_at", { ascending: true });

    if (orderTicketsError) {
      return { success: false as const, message: orderTicketsError.message };
    }

    purchaseTickets = (orderTickets ?? []).map((ticket) => {
      const orderItem = getRelation(
        ticket.order_items as
          | {
              holder_full_name?: string | null;
              shirt_type?: string | null;
              shirt_size?: string | null;
              participants?: { full_name?: string | null } | Array<{ full_name?: string | null }> | null;
              ticket_categories?: { name?: string | null } | Array<{ name?: string | null }> | null;
            }
          | Array<{
              holder_full_name?: string | null;
              shirt_type?: string | null;
              shirt_size?: string | null;
              participants?: { full_name?: string | null } | Array<{ full_name?: string | null }> | null;
              ticket_categories?: { name?: string | null } | Array<{ name?: string | null }> | null;
            }>
          | null,
      );

      const participant = getRelation(
        ticket.participants as
          | {
              full_name?: string | null;
              shirt_type?: string | null;
              shirt_size?: string | null;
              ticket_categories?: { name?: string | null } | Array<{ name?: string | null }> | null;
            }
          | Array<{
              full_name?: string | null;
              shirt_type?: string | null;
              shirt_size?: string | null;
              ticket_categories?: { name?: string | null } | Array<{ name?: string | null }> | null;
            }>
          | null,
      );

      const orderItemParticipant = getRelation(orderItem?.participants ?? null);
      const orderItemCategory = getRelation(orderItem?.ticket_categories ?? null);
      const participantCategory = getRelation(participant?.ticket_categories ?? null);

      return {
        ticket_id: String(ticket.id),
        ticket_status: String(ticket.status ?? "pending"),
        participant_id: ticket.participant_id ? String(ticket.participant_id) : null,
        holder_name: String(
          orderItem?.holder_full_name ??
            orderItemParticipant?.full_name ??
            participant?.full_name ??
            "Titular ainda não definido",
        ),
        shirt_type: String(orderItem?.shirt_type ?? participant?.shirt_type ?? ""),
        shirt_size: String(orderItem?.shirt_size ?? participant?.shirt_size ?? ""),
        category_name: String(orderItemCategory?.name ?? participantCategory?.name ?? "Sem categoria"),
      };
    });
  }

  if (kitItemsError) return { success: false as const, message: kitItemsError.message };
  if (payment.error) return { success: false as const, message: payment.error.message };
  if (ticketError) return { success: false as const, message: ticketError.message };
  if (checkinLogError) return { success: false as const, message: checkinLogError.message };

  const kitItems: Array<{
    kit_item_id: string;
    item_name: string;
    item_type: string;
    quantity: number;
    status: string;
    delivered_at: string | null;
  }> = (kitItemsData ?? []).map((item: Record<string, unknown>) => ({
    kit_item_id: String(item.kit_item_id ?? ""),
    item_name: String(item.item_name ?? "Item"),
    item_type: String(item.item_type ?? "item"),
    quantity: Number(item.quantity ?? 1),
    status: String(item.status ?? "reserved"),
    delivered_at: item.delivered_at ? String(item.delivered_at) : null,
  }));

  const eventRelation = getRelation(
    data.events as
      | {
          name?: string | null;
          kit_enabled?: boolean | null;
          wristband_enabled?: boolean | null;
          wristband_required_for_kit?: boolean | null;
          wristband_required_for_checkin?: boolean | null;
          allow_checkin_during_kit_delivery?: boolean | null;
        }
      | Array<{
          name?: string | null;
          kit_enabled?: boolean | null;
          wristband_enabled?: boolean | null;
          wristband_required_for_kit?: boolean | null;
          wristband_required_for_checkin?: boolean | null;
          allow_checkin_during_kit_delivery?: boolean | null;
        }>
      | null,
  );

  const categoryRelation = getRelation(
    data.ticket_categories as
      | { name?: string | null }
      | Array<{ name?: string | null }>
      | null,
  );

  const checkinDetails =
    checkinLogData?.details &&
    typeof checkinLogData.details === "object" &&
    !Array.isArray(checkinLogData.details)
      ? (checkinLogData.details as Record<string, unknown>)
      : null;

  const lastCheckinActor = checkinDetails
    ? String(
        checkinDetails.actor_email ??
          checkinDetails.actor_user_id ??
          checkinDetails.actor ??
          "",
      ) || null
    : null;

  const registrationStatus = String(data.registration_status ?? "pending");
  const ticketUsedAt = ticketData?.used_at ? String(ticketData.used_at) : null;
  const hasCheckin = Boolean(ticketUsedAt || checkinLogData?.id);

  const blockReason =
    payment.paymentStatus !== "paid"
      ? "Pagamento pendente."
      : registrationStatus === "cancelled"
        ? "Inscrição cancelada."
        : null;

  const deliveredCount = kitItems.filter((item) => item.status === "delivered").length;
  const kitStatus =
    kitItems.length === 0
      ? "none"
      : deliveredCount === 0
        ? "pending"
        : deliveredCount === kitItems.length
          ? "delivered"
          : "partial";

  return {
    success: true as const,
    participant: {
      id: String(data.id),
      event_id: String(data.event_id),
      full_name: String(data.full_name ?? ""),
      cpf: String(data.cpf ?? ""),
      phone: String(data.phone ?? ""),
      city: String(data.city ?? ""),
      gender: data.gender ? String(data.gender) : null,
      birth_date: data.birth_date ? String(data.birth_date) : null,
      payment_status: payment.paymentStatus,
      payment_method: payment.paymentMethod,
      registration_status: registrationStatus,
      shirt_type: String(data.shirt_type ?? ""),
      shirt_size: String(data.shirt_size ?? ""),
      category_name: String(categoryRelation?.name ?? "Sem categoria"),
      event_name: String(eventRelation?.name ?? "Evento"),
      event_kit_enabled: Boolean(eventRelation?.kit_enabled),
      event_wristband_enabled: Boolean(eventRelation?.wristband_enabled),
      event_wristband_required_for_kit: Boolean(eventRelation?.wristband_required_for_kit),
      event_wristband_required_for_checkin: Boolean(eventRelation?.wristband_required_for_checkin),
      wristband: wristbandData,
      ticket_status: ticketData?.status ? String(ticketData.status) : null,
      ticket_id: ticketData?.id ? String(ticketData.id) : null,
      ticket_token: ticketData?.token ? String(ticketData.token) : null,
      ticket_used_at: ticketUsedAt,
      last_checkin_at: checkinLogData?.created_at
        ? String(checkinLogData.created_at)
        : ticketUsedAt,
      last_checkin_actor: lastCheckinActor,
      all_kit_delivered: kitStatus === "delivered",
      kit_status: kitStatus,
      checkin_status: hasCheckin ? "done" : "pending",
      can_operate: blockReason === null,
      block_reason: blockReason,
      allow_checkin_during_kit_delivery: true,
      kit_items: kitItems,
      purchase_tickets: purchaseTickets,
    },
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
      };
    }),
  };
}

export async function listPickupParticipantsAction(filters: PickupFilters = {}) {
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
      return { success: false as const, message: eventError.message, participants: [] as PickupListItem[] };
    }

    eventId = activeEvent?.id ? String(activeEvent.id) : null;
  }

  if (!eventId) {
    return {
      success: false as const,
      message: "Nenhum evento encontrado.",
      participants: [] as PickupListItem[],
    };
  }

  const [{ data: selectedEvent, error: selectedEventError }, { data: selectedEventKitItems, error: selectedEventKitError }] =
    await Promise.all([
      supabase
        .from("events")
        .select("id, name, kit_enabled, wristband_enabled, wristband_required_for_kit, wristband_required_for_checkin")
        .eq("id", eventId)
        .maybeSingle(),
      supabase
        .from("event_kit_items")
        .select("item_type")
        .eq("event_id", eventId)
        .eq("is_active", true),
    ]);

  if (selectedEventError) {
    return { success: false as const, message: selectedEventError.message, participants: [] as PickupListItem[] };
  }

  if (selectedEventKitError) {
    return { success: false as const, message: selectedEventKitError.message, participants: [] as PickupListItem[] };
  }

  const eventHasKit =
    Boolean(selectedEvent?.kit_enabled) ||
    (selectedEventKitItems ?? []).length > 0;

  const eventHasShirt = (selectedEventKitItems ?? []).some(
    (item) => String(item.item_type ?? "").toLowerCase() === "shirt",
  );

  let query = supabase
    .from("participants")
    .select(`
      id,
      event_id,
      full_name,
      cpf,
      phone,
      city,
      gender,
      birth_date,
      registration_status,
      shirt_type,
      shirt_size,
      created_at,
      events(name),
      ticket_categories(name)
    `)
    .eq("event_id", eventId)
    .order("full_name", { ascending: true })
    .limit(500);

  const { data, error } = await query;

  if (error) {
    return {
      success: false as const,
      message: error.message,
      participants: [] as PickupListItem[],
    };
  }

  const search = normalizeSearch(filters.search ?? "");

  const baseRows = (data ?? []).filter((row: Record<string, unknown>) => {
    if (!search) return true;

    const haystack = normalizeSearch(
      [
        row.full_name,
        row.cpf,
        row.phone,
      ]
        .map((value) => String(value ?? ""))
        .join(" "),
    );

    return haystack.includes(search);
  });

  const participantIds = baseRows.map((row: Record<string, unknown>) => String(row.id));

  const [{ data: kitRows, error: kitError }, { data: ticketRows, error: ticketError }, { data: checkinRows, error: checkinError }] =
    participantIds.length > 0
      ? await Promise.all([
          supabase
            .from("participant_kit_items")
            .select("participant_id, status")
            .in("participant_id", participantIds),
          supabase
            .from("tickets")
            .select("id, participant_id, status, used_at, issued_at")
            .in("participant_id", participantIds)
            .order("issued_at", { ascending: false }),
          supabase
            .from("audit_logs")
            .select("entity_id, created_at")
            .eq("entity_type", "participants")
            .eq("action", "participant_checkin_entry")
            .in("entity_id", participantIds),
        ])
      : [
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
        ];

  if (kitError) return { success: false as const, message: kitError.message, participants: [] as PickupListItem[] };
  if (ticketError) return { success: false as const, message: ticketError.message, participants: [] as PickupListItem[] };
  if (checkinError) return { success: false as const, message: checkinError.message, participants: [] as PickupListItem[] };

  const kitMap = new Map<string, string[]>();
  for (const row of kitRows ?? []) {
    const id = String(row.participant_id ?? "");
    const statuses = kitMap.get(id) ?? [];
    statuses.push(String(row.status ?? "reserved"));
    kitMap.set(id, statuses);
  }

  const ticketMap = new Map<string, Record<string, unknown>>();
  for (const row of ticketRows ?? []) {
    const id = String(row.participant_id ?? "");
    if (!ticketMap.has(id)) {
      ticketMap.set(id, row as Record<string, unknown>);
    }
  }

  const ticketIds = Array.from(
    new Set(
      Array.from(ticketMap.values())
        .map((ticket) => String(ticket.id ?? ""))
        .filter(Boolean),
    ),
  );

  const wristbandMap = new Map<string, {
    id: string;
    code: string;
    status: string;
    linked_at: string | null;
  }>();

  if (ticketIds.length > 0) {
    const { data: wristbandRows, error: wristbandError } = await supabase
      .from("participant_wristbands")
      .select("id, ticket_id, code, status, linked_at")
      .in("ticket_id", ticketIds)
      .eq("status", "active");

    if (wristbandError) {
      return { success: false as const, message: wristbandError.message, participants: [] as PickupListItem[] };
    }

    for (const row of wristbandRows ?? []) {
      const ticketId = String(row.ticket_id ?? "");
      if (!ticketId || wristbandMap.has(ticketId)) continue;
      wristbandMap.set(ticketId, {
        id: String(row.id),
        code: String(row.code ?? ""),
        status: String(row.status ?? "active"),
        linked_at: row.linked_at ? String(row.linked_at) : null,
      });
    }
  }

  const checkinSet = new Set(
    (checkinRows ?? []).map((row) => String(row.entity_id ?? "")),
  );

  const paymentResults = await Promise.all(
    participantIds.map(async (participantId) => [
      participantId,
      await getLatestPayment(supabase, participantId),
    ] as const),
  );

  const paymentMap = new Map(paymentResults);

  const participants: PickupListItem[] = baseRows.map((row: Record<string, unknown>) => {
    const participantId = String(row.id);
    const eventRelation = getRelation(
      row.events as { name?: string | null } | Array<{ name?: string | null }> | null,
    );
    const categoryRelation = getRelation(
      row.ticket_categories as
        | { name?: string | null }
        | Array<{ name?: string | null }>
        | null,
    );

    const payment = paymentMap.get(participantId);
    const paymentStatus = payment?.paymentStatus ?? "pending";
    const paymentMethod = payment?.paymentMethod ?? "-";
    const kitStatuses = kitMap.get(participantId) ?? [];
    const deliveredCount = kitStatuses.filter((status) => status === "delivered").length;
    const kitStatus: PickupListItem["kit_status"] =
      kitStatuses.length === 0
        ? "none"
        : deliveredCount === 0
          ? "pending"
          : deliveredCount === kitStatuses.length
            ? "delivered"
            : "partial";

    const ticket = ticketMap.get(participantId);
    const ticketUsedAt = ticket?.used_at ? String(ticket.used_at) : null;
    const hasCheckin = Boolean(ticketUsedAt || checkinSet.has(participantId));
    const registrationStatus = String(row.registration_status ?? "pending");

    const blockReason =
      paymentStatus !== "paid"
        ? "Pagamento pendente."
        : registrationStatus === "cancelled"
          ? "Inscrição cancelada."
          : null;

    return {
      id: participantId,
      event_id: String(row.event_id),
      full_name: String(row.full_name ?? ""),
      cpf: String(row.cpf ?? ""),
      phone: String(row.phone ?? ""),
      city: String(row.city ?? ""),
      gender: row.gender ? String(row.gender) : null,
      birth_date: row.birth_date ? String(row.birth_date) : null,
      payment_status: paymentStatus,
      payment_method: paymentMethod,
      registration_status: registrationStatus,
      shirt_type: String(row.shirt_type ?? ""),
      shirt_size: String(row.shirt_size ?? ""),
      category_name: String(categoryRelation?.name ?? "Sem categoria"),
      event_name: String(eventRelation?.name ?? "Evento"),
      ticket_id: ticket?.id ? String(ticket.id) : null,
      ticket_status: ticket?.status ? String(ticket.status) : null,
      ticket_used_at: ticketUsedAt,
      kit_status: kitStatus,
      checkin_status: hasCheckin ? "done" : "pending",
      can_operate: blockReason === null,
      block_reason: blockReason,
      event_has_kit: eventHasKit,
      event_has_shirt: eventHasShirt,
      event_wristband_enabled: Boolean(selectedEvent?.wristband_enabled),
      event_wristband_required_for_kit: Boolean(selectedEvent?.wristband_required_for_kit),
      event_wristband_required_for_checkin: Boolean(selectedEvent?.wristband_required_for_checkin),
      wristband: ticket?.id ? wristbandMap.get(String(ticket.id)) ?? null : null,
    };
  });

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
    participants,
  };
}

export async function getPickupParticipantDetailsAction(participantId: string) {
  await assertPermission("participants.view");

  const supabase = await createServerSupabaseClient();
  return buildPickupDetails(supabase, participantId);
}

export async function searchPickupParticipantAction(query: string) {
  await assertPermission("participants.view");

  const supabase = await createServerSupabaseClient();
  const q = query.trim();

  if (!q) {
    return {
      success: false as const,
      message: "Informe nome, CPF ou telefone.",
    };
  }

  const { data, error } = await supabase
    .from("participants")
    .select("id")
    .or(`full_name.ilike.%${q}%,cpf.ilike.%${q}%,phone.ilike.%${q}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data?.id) {
    return {
      success: false as const,
      message: error?.message ?? "Nenhum inscrito encontrado.",
    };
  }

  return buildPickupDetails(supabase, String(data.id));
}

export async function searchPickupParticipantByQrAction(rawValue: string) {
  await assertPermission("participants.view");

  const supabase = await createServerSupabaseClient();
  const value = rawValue.trim();

  if (!value) {
    return { success: false as const, message: "QR Code vazio." };
  }

  const tokenCandidate = (() => {
    try {
      const url = new URL(value);
      return (
        url.searchParams.get("token") ??
        url.pathname.split("/").filter(Boolean).pop() ??
        value
      );
    } catch {
      return value;
    }
  })();

  const { data: ticket, error } = await supabase
    .from("tickets")
    .select("participant_id")
    .eq("token", tokenCandidate)
    .limit(1)
    .maybeSingle();

  if (error || !ticket?.participant_id) {
    return {
      success: false as const,
      message: error?.message ?? "Ingresso não encontrado para este QR Code.",
    };
  }

  return buildPickupDetails(supabase, String(ticket.participant_id));
}

export async function deliverKitItemAction(payload: { participant_id: string; kit_item_id: string }) {
  await assertPermission("kits.deliver");

  const supabase = await createServerSupabaseClient();

  const [
    { data: participant, error: participantError },
    { data: paymentData, error: paymentError },
  ] = await Promise.all([
    supabase
      .from("participants")
      .select("id, registration_status")
      .eq("id", payload.participant_id)
      .maybeSingle(),
    supabase.rpc("get_participant_payment_details", {
      p_participant_id: payload.participant_id,
    }),
  ]);

  if (participantError) {
    return { success: false, message: participantError.message };
  }

  if (paymentError) {
    return { success: false, message: paymentError.message };
  }

  if (!participant?.id) {
    return { success: false, message: "Participante não encontrado." };
  }

  const paymentRow = (
    Array.isArray(paymentData) ? paymentData[0] : paymentData
  ) as Record<string, unknown> | null;

  const paymentStatus = String(paymentRow?.payment_status ?? "pending");

  if (paymentStatus !== "paid") {
    return { success: false, message: "Pagamento pendente. Libere o pagamento antes da retirada." };
  }

  if (String(participant.registration_status ?? "pending") === "cancelled") {
    return { success: false, message: "Inscrição cancelada. Operação bloqueada." };
  }

  const { error } = await supabase.rpc("deliver_participant_kit_item", {
    p_participant_id: payload.participant_id,
    p_kit_item_id: payload.kit_item_id,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, message: "Item entregue com sucesso." };
}

export async function deliverFullKitAction(payload: { participant_id: string }) {
  await assertPermission("kits.deliver");

  const supabase = await createServerSupabaseClient();

  const [
    { data: participant, error: participantError },
    { data: paymentData, error: paymentError },
  ] = await Promise.all([
    supabase
      .from("participants")
      .select("id, registration_status")
      .eq("id", payload.participant_id)
      .maybeSingle(),
    supabase.rpc("get_participant_payment_details", {
      p_participant_id: payload.participant_id,
    }),
  ]);

  if (participantError) {
    return { success: false, message: participantError.message };
  }

  if (paymentError) {
    return { success: false, message: paymentError.message };
  }

  if (!participant?.id) {
    return { success: false, message: "Participante não encontrado." };
  }

  const paymentRow = (
    Array.isArray(paymentData) ? paymentData[0] : paymentData
  ) as Record<string, unknown> | null;

  const paymentStatus = String(paymentRow?.payment_status ?? "pending");

  if (paymentStatus !== "paid") {
    return { success: false, message: "Pagamento pendente. Libere o pagamento antes da retirada." };
  }

  if (String(participant.registration_status ?? "pending") === "cancelled") {
    return { success: false, message: "Inscrição cancelada. Operação bloqueada." };
  }

  const { data: pendingItems, error: pendingItemsError } = await supabase
    .from("participant_kit_items")
    .select("id")
    .eq("participant_id", payload.participant_id)
    .neq("status", "delivered")
    .limit(1);

  if (pendingItemsError) {
    return { success: false, message: pendingItemsError.message };
  }

  if ((pendingItems ?? []).length === 0) {
    return { success: false, message: "Kit já foi entregue anteriormente." };
  }

  const { error } = await supabase.rpc("deliver_participant_full_kit", {
    p_participant_id: payload.participant_id,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, message: "Kit completo entregue com sucesso." };
}

export async function checkinEntryAction(payload: { participant_id: string }) {
  await assertPermission("checkin.scan");

  const supabase = await createServerSupabaseClient();

  const { data: participant, error: participantError } = await supabase
    .from("participants")
    .select("id, event_id, full_name, registration_status, events(name), ticket_categories(name)")
    .eq("id", payload.participant_id)
    .maybeSingle();

  if (participantError) {
    return { success: false, message: participantError.message };
  }

  if (!participant?.id) {
    return { success: false, message: "Participante não encontrado." };
  }

  const [
    { data: paymentData, error: paymentError },
    { data: ticket, error: ticketError },
    { data: latestCheckin, error: checkinError },
  ] = await Promise.all([
    supabase.rpc("get_participant_payment_details", {
      p_participant_id: payload.participant_id,
    }),
    supabase
      .from("tickets")
      .select("id, status, used_at")
      .eq("participant_id", payload.participant_id)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("audit_logs")
      .select("id, created_at, details")
      .eq("entity_type", "participants")
      .eq("entity_id", payload.participant_id)
      .eq("action", "participant_checkin_entry")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (paymentError) {
    return { success: false, message: paymentError.message };
  }

  if (ticketError) {
    return { success: false, message: ticketError.message };
  }

  if (checkinError) {
    return { success: false, message: checkinError.message };
  }

  const paymentRow = (
    Array.isArray(paymentData) ? paymentData[0] : paymentData
  ) as Record<string, unknown> | null;

  const paymentStatus = String(paymentRow?.payment_status ?? "pending");

  const eventRelation = Array.isArray(participant.events)
    ? participant.events[0] ?? null
    : (participant.events as { name?: string | null } | null);

  const categoryRelation = Array.isArray(participant.ticket_categories)
    ? participant.ticket_categories[0] ?? null
    : (participant.ticket_categories as { name?: string | null } | null);

  const latestCheckinDetails =
    latestCheckin?.details &&
    typeof latestCheckin.details === "object" &&
    !Array.isArray(latestCheckin.details)
      ? (latestCheckin.details as Record<string, unknown>)
      : null;

  const latestCheckinActor = latestCheckinDetails
    ? String(
        latestCheckinDetails.actor_email ??
          latestCheckinDetails.actor_user_id ??
          latestCheckinDetails.actor ??
          "",
      ) || null
    : null;

  const eventName = String(eventRelation?.name ?? "Evento");
  const categoryName = String(categoryRelation?.name ?? "Sem categoria");
  const participantName = String(participant.full_name ?? "Participante");

  if (paymentStatus !== "paid") {
    return {
      success: false,
      message: `Entrada bloqueada: pagamento pendente para ${participantName} (${eventName} • ${categoryName}).`,
    };
  }

  if (String(participant.registration_status ?? "pending") === "cancelled") {
    return {
      success: false,
      message: `Entrada bloqueada: inscrição cancelada para ${participantName}.`,
    };
  }

  if (ticket?.status === "used" || ticket?.used_at || latestCheckin?.id) {
    const when = ticket?.used_at ?? latestCheckin?.created_at;
    const actor = latestCheckinActor ? ` por ${latestCheckinActor}` : "";

    return {
      success: false,
      message: `Atenção: ingresso já utilizado${when ? ` em ${new Date(String(when)).toLocaleString("pt-BR")}` : ""}${actor}.`,
    };
  }

  const { error } = await supabase.rpc("checkin_participant_entry", {
    p_participant_id: payload.participant_id,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  if (ticket?.id) {
    const { error: ticketUpdateError } = await supabase
      .from("tickets")
      .update({ status: "used", used_at: new Date().toISOString() })
      .eq("id", ticket.id);

    if (ticketUpdateError) {
      return { success: false, message: ticketUpdateError.message };
    }
  }

  return {
    success: true,
    message: `Entrada confirmada para ${participantName} (${eventName} • ${categoryName}) em ${new Date().toLocaleString("pt-BR")}.`,
  };
}

export async function deliverKitAndCheckinAction(payload: { participant_id: string }) {
  await assertPermission("kits.deliver");
  await assertPermission("checkin.scan");

  const supabase = await createServerSupabaseClient();

  const { data: pendingItems, error: pendingItemsError } = await supabase
    .from("participant_kit_items")
    .select("id")
    .eq("participant_id", payload.participant_id)
    .neq("status", "delivered")
    .limit(1);

  if (pendingItemsError) {
    return { success: false, message: pendingItemsError.message };
  }

  if ((pendingItems ?? []).length > 0) {
    const { error: deliveryError } = await supabase.rpc("deliver_participant_full_kit", {
      p_participant_id: payload.participant_id,
    });

    if (deliveryError) {
      return { success: false, message: deliveryError.message };
    }
  }

  const { error: checkinError } = await supabase.rpc("checkin_participant_entry", {
    p_participant_id: payload.participant_id,
  });

  if (checkinError) {
    return {
      success: false,
      message: `Kit entregue, mas o check-in falhou: ${checkinError.message}`,
      kit_delivered: true,
      checkin_done: false,
    };
  }

  const { data: ticket } = await supabase
    .from("tickets")
    .select("id")
    .eq("participant_id", payload.participant_id)
    .order("issued_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (ticket?.id) {
    await supabase
      .from("tickets")
      .update({ status: "used", used_at: new Date().toISOString() })
      .eq("id", ticket.id);
  }

  return {
    success: true,
    message: "Kit entregue e entrada confirmada.",
    kit_delivered: true,
    checkin_done: true,
  };
}
