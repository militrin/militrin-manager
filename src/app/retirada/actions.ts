"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function searchPickupParticipantAction(query: string) {
  const supabase = await createServerSupabaseClient();
  const q = query.trim();

  if (!q) {
    return { success: false, message: "Informe nome, CPF, telefone ou número da inscrição." };
  }

  const { data, error } = await supabase
    .from("participants")
    .select("id, event_id, full_name, registration_number, cpf, phone, payment_status, registration_status, shirt_type, shirt_size, events(name, kit_enabled)")
    .or(`full_name.ilike.%${q}%,cpf.ilike.%${q}%,phone.ilike.%${q}%,registration_number.eq.${Number(q) || 0}`)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return { success: false, message: "Nenhum inscrito encontrado." };
  }

  const participantId = String(data.id);
  const eventId = String(data.event_id);
  const { data: kitItemsData, error: kitItemsError } = await supabase.rpc("get_participant_kit_items", {
    p_participant_id: participantId,
  });

  if (kitItemsError) {
    return { success: false, message: kitItemsError.message };
  }

  const kitItems = (kitItemsData ?? []).map((item: {
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

  return {
    success: true,
    participant: {
      id: participantId,
      event_id: eventId,
      full_name: String(data.full_name),
      registration_number: data.registration_number === null || data.registration_number === undefined ? null : Number(data.registration_number),
      cpf: String(data.cpf),
      phone: String(data.phone),
      payment_status: String(data.payment_status ?? "pending"),
      registration_status: String(data.registration_status ?? "pending"),
      shirt_type: String(data.shirt_type ?? ""),
      shirt_size: String(data.shirt_size ?? ""),
      event_name: String(eventRelation?.name ?? "Evento"),
      event_kit_enabled: Boolean(eventRelation?.kit_enabled),
      kit_items: kitItems,
    },
  };
}

export async function deliverKitItemAction(payload: { participant_id: string; kit_item_id: string }) {
  const supabase = await createServerSupabaseClient();
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
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("deliver_participant_full_kit", {
    p_participant_id: payload.participant_id,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, message: "Kit completo entregue com sucesso." };
}

export async function checkinEntryAction(payload: { participant_id: string }) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("checkin_participant_entry", {
    p_participant_id: payload.participant_id,
  });

  if (error) {
    return { success: false, message: error.message };
  }

  return { success: true, message: "Entrada confirmada com sucesso." };
}
