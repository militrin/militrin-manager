"use server";

import { revalidatePath } from "next/cache";
import { assertPermission, hasPermission } from "@/lib/admin/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { finalizeCadastroPaymentAndTicketAction } from "@/app/cadastros/actions";

const ALLOWED_GENDERS = new Set(["male", "female", "other", "prefer_not_to_say"]);

async function requireParticipantContext(participantId: string) {
  const supabase = await createServerSupabaseClient();
  const { data: participant, error } = await supabase.from("participants")
    .select("id,event_id,organization_id,notes,registration_contacts(full_name,birth_date,phone,email,city,gender)")
    .eq("id", participantId).maybeSingle();
  if (error || !participant) throw error ?? new Error("Participante não encontrado.");
  const registrationContact = Array.isArray(participant.registration_contacts)
    ? participant.registration_contacts[0]
    : participant.registration_contacts;
  if (!registrationContact) throw new Error("Cadastro global não encontrado.");
  const { data: canAccess, error: accessError } = await supabase.rpc("user_can_access_organization", {
    p_user_id: (await supabase.auth.getUser()).data.user?.id,
    p_organization_id: participant.organization_id,
  });
  if (accessError || !canAccess) throw new Error("Sem acesso à organização do cadastro.");
  return { supabase, participant: { ...participant, ...registrationContact } };
}

export async function getParticipantEditContext(participantId: string) {
  await assertPermission("participants.edit_basic");
  const { supabase, participant } = await requireParticipantContext(participantId);
  const [{ data: payments, error: paymentError }, { data: tickets, error: ticketError }] = await Promise.all([
    supabase.from("payments").select("id,payment_method,payment_status,final_amount,amount")
      .eq("participant_id", participantId).eq("event_id", participant.event_id).limit(2),
    supabase.from("tickets").select("id,status,order_item_id,order_items(shirt_type,shirt_size)").eq("participant_id", participantId)
      .eq("event_id", participant.event_id).neq("status", "cancelled").limit(2),
  ]);
  if (paymentError) throw paymentError;
  if (ticketError) throw ticketError;
  if ((payments?.length ?? 0) > 1) throw new Error("Mais de um pagamento encontrado para este cadastro.");
  if ((tickets?.length ?? 0) > 1) throw new Error("Mais de um ingresso encontrado para este cadastro.");
  const payment = payments?.[0] ?? null;
  const ticket = tickets?.[0] ?? null;
  const orderItem = Array.isArray(ticket?.order_items) ? ticket.order_items[0] : ticket?.order_items;
  const participantView = {
    ...participant,
    shirt_type: orderItem?.shirt_type ?? null,
    shirt_size: orderItem?.shirt_size ?? null,
  };
  const [canConfirmPayment, canChangeShirt] = await Promise.all([
    hasPermission("finance.confirm_payment"),
    hasPermission("inventory.change_participant_shirt"),
  ]);

  let shirtOptions: Array<Record<string, unknown>> = [];
  let shirtDelivered = false;
  let shirtCheckinDone = false;
  if (ticket?.id && canChangeShirt) {
    const [{ data: options, error: optionError }, { data: kitItems, error: kitError }] = await Promise.all([
      supabase.rpc("get_admin_ticket_shirt_options", { p_ticket_id: ticket.id }),
      supabase.rpc("get_ticket_kit_items", { p_ticket_id: ticket.id }),
    ]);
    if (optionError) throw optionError;
    if (kitError) throw kitError;
    shirtOptions = (options ?? []) as Array<Record<string, unknown>>;
    shirtDelivered = ((kitItems ?? []) as Array<Record<string, unknown>>).some(
      (item) => item.item_type === "shirt" && item.status === "delivered",
    );
    shirtCheckinDone = ticket.status === "used";
  }

  return {
    participant: participantView,
    payment,
    ticketId: ticket?.id ?? null,
    shirtOptions,
    shirtDelivered,
    // Tamanho trava no fluxo normal apos kit entregue OU check-in realizado
    // -- espelha exatamente o que admin_change_ticket_shirt valida no
    // backend (SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION), nunca so o kit.
    shirtLocked: shirtDelivered || shirtCheckinDone,
    canConfirmPayment,
    canChangeShirt,
  };
}

export async function updateParticipantDetails(payload: {
  id: string; full_name: string; birth_date: string; phone: string; email: string;
  city: string | null; gender: string | null; notes: string | null;
}) {
  await assertPermission("participants.edit_basic");
  if (payload.gender && !ALLOWED_GENDERS.has(payload.gender)) throw new Error("Sexo inválido.");
  const { supabase } = await requireParticipantContext(payload.id);
  const { error } = await supabase.rpc("update_registration_contact_from_participant", {
    p_participant_id: payload.id,
    p_values: {
      full_name: payload.full_name, birth_date: payload.birth_date, phone: payload.phone,
      email: payload.email.trim().toLowerCase(), city: payload.city, gender: payload.gender,
    },
  });
  if (error) throw error;
  const { error: noteError } = await supabase.rpc("update_participant_event_notes", {
    p_participant_id: payload.id, p_notes: payload.notes,
  });
  if (noteError) throw noteError;
  revalidatePath(`/inscricoes/${payload.id}`);
  revalidatePath(`/inscricoes/${payload.id}/editar`);
  return { success: true as const, message: "Dados cadastrais atualizados." };
}

export async function confirmParticipantPaymentFromEditAction(participantId: string) {
  const { participant, payment } = await getParticipantEditContext(participantId);
  if (!payment) throw new Error("Pagamento não encontrado.");
  if (payment.payment_status === "paid") return { success: true as const, message: "Pagamento já confirmado." };
  return finalizeCadastroPaymentAndTicketAction({
    participantId,
    paymentId: payment.id,
    eventId: participant.event_id,
    organizationId: participant.organization_id,
  });
}

function friendlyShirtRpcError(error: { message: string }): Error {
  if (error.message.includes("SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION")) {
    return new Error("O tamanho não pode mais ser alterado porque este ingresso já teve kit entregue ou check-in realizado.");
  }
  if (error.message.includes("SHIRT_OUT_OF_STOCK")) {
    return new Error("Não há estoque disponível para este modelo e tamanho.");
  }
  return new Error(error.message);
}

export async function changeParticipantShirtFromEditAction(input: {
  participantId: string; ticketId: string; shirtType: string; shirtSize: string;
}) {
  await assertPermission("inventory.change_participant_shirt");
  const context = await getParticipantEditContext(input.participantId);
  if (context.ticketId !== input.ticketId) throw new Error("Ingresso não corresponde ao cadastro.");
  if (context.shirtLocked) throw new Error("O tamanho não pode mais ser alterado porque este ingresso já teve kit entregue ou check-in realizado.");
  const allowed = context.shirtOptions.some((option) => option.shirt_type === input.shirtType && option.shirt_size === input.shirtSize);
  if (!allowed) throw new Error("Combinação de modelo e tamanho não habilitada para o evento.");
  const { supabase } = await requireParticipantContext(input.participantId);
  const { error } = await supabase.rpc("admin_change_ticket_shirt", {
    p_ticket_id: input.ticketId,
    p_new_shirt_type: input.shirtType,
    p_new_shirt_size: input.shirtSize,
  });
  if (error) throw friendlyShirtRpcError(error);
  revalidatePath(`/inscricoes/${input.participantId}/editar`);
  revalidatePath(`/ingressos/${input.ticketId}`);
  return { success: true as const, message: "Camiseta atualizada." };
}

// Unico caminho valido pra corrigir tamanho depois de kit entregue ou
// check-in realizado (context.shirtLocked=true). Exige motivo -- mesmo
// catalogo REASON_CODES ja usado pelas RPCs de undo do modulo operacional.
export async function correctParticipantShirtAfterOperationAction(input: {
  participantId: string; ticketId: string; shirtType: string; shirtSize: string;
  reasonCode: string; reasonText?: string;
}) {
  await assertPermission("inventory.change_participant_shirt");
  const context = await getParticipantEditContext(input.participantId);
  if (context.ticketId !== input.ticketId) throw new Error("Ingresso não corresponde ao cadastro.");
  if (!context.shirtLocked) throw new Error("Este ingresso ainda não teve kit entregue nem check-in; use a troca normal de tamanho.");
  if (!input.reasonCode.trim()) throw new Error("Motivo obrigatório.");
  const { supabase } = await requireParticipantContext(input.participantId);
  const { error } = await supabase.rpc("admin_correct_ticket_shirt_after_operation", {
    p_ticket_id: input.ticketId,
    p_new_shirt_type: input.shirtType,
    p_new_shirt_size: input.shirtSize,
    p_reason_code: input.reasonCode,
    p_reason_text: input.reasonText?.trim() || null,
  });
  if (error) throw friendlyShirtRpcError(error);
  revalidatePath(`/inscricoes/${input.participantId}/editar`);
  revalidatePath(`/ingressos/${input.ticketId}`);
  return { success: true as const, message: "Tamanho corrigido com sucesso." };
}
