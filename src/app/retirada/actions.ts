"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";

export async function searchPickupParticipantAction(query: string) {
  await assertPermission("participants.view");

  const supabase = await createServerSupabaseClient();
  const q = query.trim();

  if (!q) {
    return { success: false, message: "Informe nome, CPF, telefone ou número da inscrição." };
  }

  const { data, error } = await supabase
    .from("participants")
    .select("id, event_id, full_name, registration_number, cpf, phone, payment_status, registration_status, shirt_type, shirt_size, events(name, kit_enabled), ticket_categories(name)")
    .or(`full_name.ilike.%${q}%,cpf.ilike.%${q}%,phone.ilike.%${q}%,registration_number.eq.${Number(q) || 0}`)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return { success: false, message: "Nenhum inscrito encontrado." };
  }

  const participantId = String(data.id);
  const eventId = String(data.event_id);
  const [{ data: kitItemsData, error: kitItemsError }, { data: paymentData, error: paymentError }, { data: ticketData, error: ticketError }, { data: checkinLogData, error: checkinLogError }] = await Promise.all([
    supabase.rpc("get_participant_kit_items", {
      p_participant_id: participantId,
    }),
    supabase.rpc("get_participant_payment_details", {
      p_participant_id: participantId,
    }),
    supabase
      .from("tickets")
      .select("id, status, used_at")
      .eq("participant_id", participantId)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("audit_logs")
      .select("id, actor, created_at")
      .eq("entity_type", "participants")
      .eq("entity_id", participantId)
      .eq("action", "participant_checkin_entry")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (kitItemsError) {
    return { success: false, message: kitItemsError.message };
  }

  if (paymentError) {
    return { success: false, message: paymentError.message };
  }

  if (ticketError) {
    return { success: false, message: ticketError.message };
  }

  if (checkinLogError) {
    return { success: false, message: checkinLogError.message };
  }

  const paymentRow = (Array.isArray(paymentData) ? paymentData[0] : paymentData) as Record<string, unknown> | null;
  const paymentStatus = paymentRow?.payment_status ? String(paymentRow.payment_status) : String(data.payment_status ?? "pending");
  const paymentMethod = paymentRow?.payment_method ? String(paymentRow.payment_method) : "-";
  const ticketStatus = ticketData?.status ? String(ticketData.status) : null;
  const ticketUsedAt = ticketData?.used_at ? String(ticketData.used_at) : null;
  const hasCheckinLog = Boolean(checkinLogData?.id);

  const kitItems: Array<{
    kit_item_id: string;
    item_name: string;
    item_type: string;
    quantity: number;
    status: string;
    delivered_at: string | null;
  }> = (kitItemsData ?? []).map((item: {
    kit_item_id: string;
    item_name: string;
    item_type: string;
    quantity: number;
    status: string;
    delivered_at: string | null;
  }) => ({
    kit_item_id: String(item.kit_item_id),
    item_name: String(item.item_name),
    item_type: String(item.item_type),
    quantity: Number(item.quantity ?? 1),
    status: String(item.status ?? "reserved"),
    delivered_at: item.delivered_at ? String(item.delivered_at) : null,
  }));

  const eventRelation = Array.isArray(data.events)
    ? data.events[0] ?? null
    : (data.events as { name?: string | null; kit_enabled?: boolean | null } | null);
  const categoryRelation = Array.isArray(data.ticket_categories)
    ? data.ticket_categories[0] ?? null
    : (data.ticket_categories as { name?: string | null } | null);

  const blockReason =
    paymentStatus !== "paid"
      ? "Pagamento pendente."
      : String(data.registration_status ?? "pending") === "cancelled"
      ? "Inscrição cancelada."
      : ticketStatus === "used" || Boolean(ticketUsedAt) || hasCheckinLog
      ? "Entrada já utilizada anteriormente."
      : null;

  const allKitDelivered = kitItems.length > 0 && kitItems.every((item) => item.status === "delivered");

  return {
    success: true,
    participant: {
      id: participantId,
      event_id: eventId,
      full_name: String(data.full_name),
      registration_number: data.registration_number === null || data.registration_number === undefined ? null : Number(data.registration_number),
      cpf: String(data.cpf),
      phone: String(data.phone),
      payment_status: paymentStatus,
      payment_method: paymentMethod,
      registration_status: String(data.registration_status ?? "pending"),
      shirt_type: String(data.shirt_type ?? ""),
      shirt_size: String(data.shirt_size ?? ""),
      category_name: String(categoryRelation?.name ?? "Sem categoria"),
      event_name: String(eventRelation?.name ?? "Evento"),
      event_kit_enabled: Boolean(eventRelation?.kit_enabled),
      ticket_status: ticketStatus,
      ticket_used_at: ticketUsedAt,
      last_checkin_at: checkinLogData?.created_at ? String(checkinLogData.created_at) : null,
      last_checkin_actor: checkinLogData?.actor ? String(checkinLogData.actor) : null,
      all_kit_delivered: allKitDelivered,
      can_operate: blockReason === null,
      block_reason: blockReason,
      kit_items: kitItems,
    },
  };
}

export async function deliverKitItemAction(payload: { participant_id: string; kit_item_id: string }) {
  await assertPermission("kits.deliver");

  const supabase = await createServerSupabaseClient();

  const { data: participant } = await supabase
    .from("participants")
    .select("id, payment_status, registration_status")
    .eq("id", payload.participant_id)
    .maybeSingle();

  if (!participant?.id) {
    return { success: false, message: "Participante não encontrado." };
  }

  if (String(participant.payment_status ?? "pending") !== "paid") {
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

  const { data: participant } = await supabase
    .from("participants")
    .select("id, payment_status, registration_status")
    .eq("id", payload.participant_id)
    .maybeSingle();

  if (!participant?.id) {
    return { success: false, message: "Participante não encontrado." };
  }

  if (String(participant.payment_status ?? "pending") !== "paid") {
    return { success: false, message: "Pagamento pendente. Libere o pagamento antes da retirada." };
  }

  if (String(participant.registration_status ?? "pending") === "cancelled") {
    return { success: false, message: "Inscrição cancelada. Operação bloqueada." };
  }

  const { data: pendingItems } = await supabase
    .from("participant_kit_items")
    .select("id")
    .eq("participant_id", payload.participant_id)
    .neq("status", "delivered")
    .limit(1);

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
    .select("id, event_id, full_name, payment_status, registration_status, events(name), ticket_categories(name)")
    .eq("id", payload.participant_id)
    .maybeSingle();

  if (participantError) {
    return { success: false, message: participantError.message };
  }

  if (!participant?.id) {
    return { success: false, message: "Participante não encontrado." };
  }

  const [{ data: ticket }, { data: latestCheckin }] = await Promise.all([
    supabase
      .from("tickets")
      .select("id, status, used_at")
      .eq("participant_id", payload.participant_id)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("audit_logs")
      .select("id, actor, created_at")
      .eq("entity_type", "participants")
      .eq("entity_id", payload.participant_id)
      .eq("action", "participant_checkin_entry")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const eventRelation = Array.isArray(participant.events)
    ? participant.events[0] ?? null
    : (participant.events as { name?: string | null } | null);
  const categoryRelation = Array.isArray(participant.ticket_categories)
    ? participant.ticket_categories[0] ?? null
    : (participant.ticket_categories as { name?: string | null } | null);

  const eventName = String(eventRelation?.name ?? "Evento");
  const categoryName = String(categoryRelation?.name ?? "Sem categoria");
  const participantName = String(participant.full_name ?? "Participante");

  if (String(participant.payment_status ?? "pending") !== "paid") {
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
    const actor = latestCheckin?.actor ? ` por ${String(latestCheckin.actor)}` : "";
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
    await supabase
      .from("tickets")
      .update({ status: "used", used_at: new Date().toISOString() })
      .eq("id", ticket.id);
  }

  return {
    success: true,
    message: `Entrada confirmada para ${participantName} (${eventName} • ${categoryName}) em ${new Date().toLocaleString("pt-BR")}.`,
  };
}
