"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { getEmailProvider } from "@/lib/email/fake-provider";
import { assertPermission } from "@/lib/admin/permissions";
import { normalizeShirtSize, normalizeShirtType } from "@/lib/constants/shirts";

const emailProvider = getEmailProvider();

export async function releaseExpiredReservationsAction() {
  await assertPermission("participants.view");

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("release_expired_reservations");

  if (error) {
    console.error("ERRO AO LIBERAR RESERVAS EXPIRADAS:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    return { success: false, released: 0, message: error.message };
  }

  return { success: true, released: Number(data ?? 0), message: null as string | null };
}

export async function confirmParticipantPaymentAction(participantId: string) {
  await assertPermission("finance.confirm_payment");

  const supabase = await createServerSupabaseClient();

  const { data: participant, error: participantError } = await supabase
    .from("participants")
    .select("id, event_id, registration_status")
    .eq("id", participantId)
    .maybeSingle();

  if (participantError) return { success: false, message: participantError.message };
  if (!participant?.id) return { success: false, message: "Participante nao encontrado." };

  const { data: payment, error: paymentError } = await supabase
    .from("payments")
    .select("id, payment_method, payment_status")
    .eq("participant_id", participantId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (paymentError) return { success: false, message: paymentError.message };
  if (!payment?.id) return { success: false, message: "Pagamento nao encontrado." };
  if (String(payment.payment_status ?? "pending") === "paid") {
    return { success: true, message: "Pagamento ja confirmado." };
  }

  const methodRaw = String(payment.payment_method ?? "pix").toLowerCase();
  const method = methodRaw === "credit_card" ? "credit_card" : "pix";

  const { error: rpcError } = await supabase.rpc("simulate_payment_paid", {
    p_participant_id: participantId,
    p_payment_method: method,
  });
  if (rpcError) return { success: false, message: rpcError.message };

  const { error: confirmError } = await supabase.rpc("confirm_order_and_issue_ticket", {
    p_participant_id: participantId,
  });
  if (confirmError) return { success: false, message: confirmError.message };

  await supabase
    .from("participants")
    .update({ registration_status: "confirmed" })
    .eq("id", participantId);

  revalidatePath("/painel");
  revalidatePath("/inscricoes");
  revalidatePath(`/inscricoes/${participantId}`);

  return { success: true, message: "Pagamento confirmado e ingresso emitido." };
}

export async function changeParticipantShirtAction(input: {
  participantId: string;
  shirtType: string;
  shirtSize: string;
}) {
  await assertPermission("inventory.change_participant_shirt");

  const supabase = await createServerSupabaseClient();
  const { participantId } = input;
  const shirtType = normalizeShirtType(input.shirtType);
  const shirtSize = normalizeShirtSize(input.shirtSize);

  if (!shirtType || !shirtSize) {
    return { success: false, message: "Modelo/tamanho inválidos." };
  }

  const { data: participant, error: participantError } = await supabase
    .from("participants")
    .select("id, event_id, shirt_type, shirt_size")
    .eq("id", participantId)
    .maybeSingle();

  if (participantError) return { success: false, message: participantError.message };
  if (!participant?.id) return { success: false, message: "Participante nao encontrado." };

  const { data: eventData, error: eventError } = await supabase
    .from("events")
    .select("id, limit_shirt_selection_to_stock")
    .eq("id", participant.event_id)
    .maybeSingle();

  if (eventError) return { success: false, message: eventError.message };
  if (!eventData?.id) return { success: false, message: "Evento vinculado ao participante nao encontrado." };

  const enforcePhysicalStock = Boolean(eventData.limit_shirt_selection_to_stock);

  const currentType = normalizeShirtType(String(participant.shirt_type ?? ""));
  const currentSize = normalizeShirtSize(String(participant.shirt_size ?? ""));
  if (currentType === shirtType && currentSize === shirtSize) {
    return { success: true, message: "Camiseta ja esta neste modelo e tamanho." };
  }

  const { data: currentStock, error: currentStockError } = await supabase
    .from("shirt_inventory")
    .select("id, reserved_quantity")
    .eq("event_id", participant.event_id)
    .eq("shirt_type", currentType)
    .eq("shirt_size", currentSize)
    .maybeSingle();
  if (currentStockError) return { success: false, message: currentStockError.message };

  const { data: nextStock, error: nextStockError } = await supabase
    .from("shirt_inventory")
    .select("id, total_quantity, reserved_quantity, delivered_quantity")
    .eq("event_id", participant.event_id)
    .eq("shirt_type", shirtType)
    .eq("shirt_size", shirtSize)
    .maybeSingle();
  if (nextStockError) return { success: false, message: nextStockError.message };
  if (!nextStock?.id) return { success: false, message: "Estoque nao configurado para o modelo/tamanho selecionado." };

  const available = Number(nextStock.total_quantity ?? 0) - Number(nextStock.reserved_quantity ?? 0) - Number(nextStock.delivered_quantity ?? 0);
  if (enforcePhysicalStock && available <= 0) {
    return { success: false, message: "Sem estoque disponivel para o novo tamanho/modelo." };
  }

  if (currentStock?.id && Number(currentStock.reserved_quantity ?? 0) > 0) {
    const { error: releaseError } = await supabase
      .from("shirt_inventory")
      .update({ reserved_quantity: Math.max(0, Number(currentStock.reserved_quantity ?? 0) - 1), updated_at: new Date().toISOString() })
      .eq("id", currentStock.id);
    if (releaseError) return { success: false, message: releaseError.message };
  }

  const { error: reserveError } = await supabase
    .from("shirt_inventory")
    .update({ reserved_quantity: Number(nextStock.reserved_quantity ?? 0) + 1, updated_at: new Date().toISOString() })
    .eq("id", nextStock.id);
  if (reserveError) return { success: false, message: reserveError.message };

  const { error: participantUpdateError } = await supabase
    .from("participants")
    .update({ shirt_type: shirtType, shirt_size: shirtSize })
    .eq("id", participantId);
  if (participantUpdateError) return { success: false, message: participantUpdateError.message };

  await supabase.from("audit_logs").insert({
    actor: "admin",
    action: "shirt_changed",
    entity_type: "participants",
    entity_id: participantId,
    event_id: participant.event_id,
    details: {
      previous_type: currentType,
      previous_size: currentSize,
      next_type: shirtType,
      next_size: shirtSize,
    },
  });

  revalidatePath("/inscricoes");
  revalidatePath(`/inscricoes/${participantId}`);
  revalidatePath(`/inscricoes/${participantId}/editar`);

  return { success: true, message: "Camiseta alterada com sucesso." };
}

export async function resendParticipantTicketAction(participantId: string) {
  await assertPermission("orders.resend_ticket");

  const supabase = await createServerSupabaseClient();

  const { data: participant, error: participantError } = await supabase
    .from("participants")
    .select("id, event_id, full_name, email, payment_status, registration_status, ticket_categories(name)")
    .eq("id", participantId)
    .maybeSingle();

  if (participantError) return { success: false, message: participantError.message };
  if (!participant?.id) return { success: false, message: "Participante nao encontrado." };

  const { data: order } = await supabase
    .from("orders")
    .select("id, order_number, status")
    .eq("participant_id", participantId)
    .maybeSingle();

  if (String(order?.status ?? "pending") !== "confirmed") {
    return { success: false, message: "Ingresso disponivel apenas para pedido confirmado." };
  }

  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select("token")
    .eq("participant_id", participantId)
    .maybeSingle();
  if (ticketError) return { success: false, message: ticketError.message };
  if (!ticket?.token) return { success: false, message: "Ingresso ainda nao emitido." };

  const { data: eventData } = await supabase
    .from("events")
    .select("name, starts_at, location")
    .eq("id", participant.event_id)
    .maybeSingle();

  const { data: kitItems } = await supabase.rpc("get_participant_kit_items", {
    p_participant_id: participantId,
  });

  const participantEmail = String(participant.email ?? "").trim().toLowerCase();
  if (!participantEmail) return { success: false, message: "Participante sem e-mail cadastrado." };

  const category = Array.isArray(participant.ticket_categories)
    ? participant.ticket_categories[0]
    : participant.ticket_categories;

  await emailProvider.sendTicketConfirmation({
    to: participantEmail,
    participantName: String(participant.full_name ?? ""),
    eventName: String(eventData?.name ?? "Evento"),
    eventDate: eventData?.starts_at ? new Date(String(eventData.starts_at)).toLocaleDateString("pt-BR") : null,
    eventLocation: eventData?.location ? String(eventData.location) : null,
    categoryName: category?.name ? String(category.name) : null,
    kitItems: (kitItems ?? []).map((item: Record<string, unknown>) => ({
      name: String(item.item_name ?? ""),
      quantity: Number(item.quantity ?? 1),
    })),
    orderNumber: String(order?.order_number ?? "-"),
    ticketToken: String(ticket.token),
    accountUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/inscricoes/${participantId}`,
  });

  return { success: true, message: "Ingresso reenviado por e-mail." };
}
