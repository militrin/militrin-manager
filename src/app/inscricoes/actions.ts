"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { getEmailProvider } from "@/lib/email/fake-provider";
import { assertPermission } from "@/lib/admin/permissions";
import { normalizeShirtSize, normalizeShirtType } from "@/lib/constants/shirts";
import type { UpdatePaymentStatusInput } from "./payment-status.types";

const emailProvider = getEmailProvider();

export type ResolveParticipantDataIssuesInput = {
  participantId: string;
  expectedIssueIds: string[];
  values: Partial<Record<'gender' | 'birth_date' | 'cpf' | 'shirt_type' | 'shirt_size' | 'city' | 'phone' | 'email' | 'category' | 'batch', string>>;
};

export async function getParticipantIssueOptionsAction(participantId: string) {
  const supabase = await createServerSupabaseClient();
  const { data: participant, error } = await supabase.from("participants").select("event_id").eq("id", participantId).single();
  if (error || !participant?.event_id) return { success: false as const, message: error?.message ?? "Cadastro não encontrado." };
  const eventId = String(participant.event_id);
  const { data: issueItems, error: issueItemError } = await supabase.from("participant_data_issues").select("order_item_id").eq("participant_id", participantId).eq("status", "open").not("order_item_id", "is", null);
  if (issueItemError) return { success: false as const, message: issueItemError.message };
  const issueOrderItemIds = [...new Set((issueItems ?? []).map((issue) => String(issue.order_item_id)))];
  if (issueOrderItemIds.length > 1) return { success: false as const, message: "Existem pendencias de mais de um ingresso. Abra o ingresso que deseja corrigir." };
  const { data: canonicalItem } = issueOrderItemIds.length
    ? await supabase.from("order_items").select("ticket_category_id,batch_id").eq("id", issueOrderItemIds[0]).single()
    : { data: null };
  const [categoriesResult, batchesResult, shirtsResult] = await Promise.all([
    supabase.from("ticket_categories").select("id,name").eq("event_id", eventId).eq("is_active", true).order("name"),
    supabase.from("registration_batches").select("id,name").eq("event_id", eventId).eq("is_active", true).order("starts_at"),
    supabase.from("shirt_inventory").select("shirt_type,shirt_size").eq("event_id", eventId).order("shirt_type").order("shirt_size"),
  ]);
  if (categoriesResult.error || batchesResult.error || shirtsResult.error) {
    return { success: false as const, message: categoriesResult.error?.message ?? batchesResult.error?.message ?? shirtsResult.error?.message ?? "Falha ao carregar opções." };
  }
  const batchIds = (batchesResult.data ?? []).map((item) => String(item.id));
  const prices = batchIds.length
    ? await supabase.from("registration_batch_prices").select("batch_id,ticket_category_id,male_price,female_price").in("batch_id", batchIds)
    : { data: [], error: null };
  if (prices.error) return { success: false as const, message: prices.error.message };
  const shirtMap = new Map<string, string[]>();
  for (const item of shirtsResult.data ?? []) {
    const type = String(item.shirt_type ?? ""); const size = String(item.shirt_size ?? "");
    if (type && size) shirtMap.set(type, [...(shirtMap.get(type) ?? []), size]);
  }
  return { success: true as const, currentCategoryId: canonicalItem?.ticket_category_id ? String(canonicalItem.ticket_category_id) : "", currentBatchId: canonicalItem?.batch_id ? String(canonicalItem.batch_id) : "", categories: categoriesResult.data ?? [], batches: batchesResult.data ?? [], prices: prices.data ?? [], shirts: Array.from(shirtMap, ([type, sizes]) => ({ type, sizes })) };
}
export async function resolveMyParticipantDataIssuesAction(input: ResolveParticipantDataIssuesInput) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) return { success: false as const, message: "Sessão expirada." };
  const { data: participant } = await supabase.from("participants").select("id").eq("id", input.participantId).eq("user_id", user.id).maybeSingle();
  if (!participant?.id) return { success: false as const, message: "Cadastro não vinculado a esta conta." };
  if (input.values.category || input.values.batch) return { success: false as const, message: "Categoria e lote dependem do organizador." };
  const { data: issueContext } = await supabase.from("participant_data_issues").select("order_item_id").in("id", input.expectedIssueIds).eq("status", "open");
  const issueOrderItemIds = [...new Set((issueContext ?? []).map((issue) => issue.order_item_id ? String(issue.order_item_id) : null).filter(Boolean))] as string[];
  if (issueOrderItemIds.length !== 1) return { success: false as const, message: "Abra a pendencia no ingresso correto para continuar." };
  const { data, error } = await supabase.rpc("resolve_ticket_data_issues", {
    p_order_item_id: issueOrderItemIds[0], p_expected_issue_ids: input.expectedIssueIds, p_values: input.values,
  });
  if (error) return { success: false as const, message: error.message };
  const result = data as { success?: boolean; message?: string; remaining_issues?: Array<Record<string, unknown>> } | null;
  if (!result?.success) return { success: false as const, message: result?.message ?? "Não foi possível reavaliar o cadastro." };
  const { data: finalization, error: finalizationError } = await supabase.rpc("finalize_imported_ticket_after_issue_resolution", {
    p_order_item_id: issueOrderItemIds[0], p_resolved_fields: Object.keys(input.values),
  });
  if (finalizationError) return { success: false as const, message: finalizationError.message };
  const finalized = finalization as { finalization?: string; ticket_id?: string | null } | null;
  revalidatePath("/primeiro-acesso/pendencias"); revalidatePath("/minha-conta"); revalidatePath("/minha-conta/ingressos"); revalidatePath("/operacoes"); revalidatePath("/cadastros");
  return { success: true as const, message: finalized?.ticket_id ? "Cadastro concluído e ingresso emitido." : result.message ?? "Cadastro reavaliado.", remainingIssues: result.remaining_issues ?? [], finalization: finalized?.finalization ?? null, ticketId: finalized?.ticket_id ?? null };
}

export async function resolveParticipantDataIssuesAction(input: ResolveParticipantDataIssuesInput) {
  await assertPermission("participants.edit_basic");

  if (!input.participantId || input.expectedIssueIds.length === 0) {
    return { success: false as const, message: "Pendencias invalidas." };
  }

  const supabase = await createServerSupabaseClient();
  const { data: participant, error: participantError } = await supabase.from("participants").select("event_id").eq("id", input.participantId).single();
  if (participantError || !participant?.event_id) return { success: false as const, message: participantError?.message ?? "Cadastro não encontrado." };

  const rpcValues = { ...input.values };
  const categoryId = rpcValues.category || null;
  const batchId = rpcValues.batch || null;
  delete rpcValues.category;
  delete rpcValues.batch;
  const { data: currentIssues, error: currentIssuesError } = await supabase.from("participant_data_issues").select("id,order_item_id").eq("participant_id", input.participantId).eq("status", "open");
  if (currentIssuesError) return { success: false as const, message: currentIssuesError.message };
  const currentIds = (currentIssues ?? []).map((issue) => String(issue.id)).sort();
  const expectedIds = [...input.expectedIssueIds].sort();
  if (currentIds.length !== expectedIds.length || currentIds.some((id, index) => id !== expectedIds[index])) {
    return { success: false as const, conflict: true, message: "As pendências foram atualizadas por outro usuário. Recarregue e tente novamente." };
  }
  const orderItemIds = [...new Set((currentIssues ?? []).map((issue) => issue.order_item_id ? String(issue.order_item_id) : null).filter(Boolean))] as string[];
  if (orderItemIds.length !== 1) return { success: false as const, message: "Abra a pendencia no ingresso correto para continuar." };
  const orderItemId = orderItemIds[0];
  if (categoryId && !(await supabase.from("ticket_categories").select("id", { count: "exact", head: true }).eq("id", categoryId).eq("event_id", participant.event_id)).count) {
    return { success: false as const, message: "Categoria inválida para este evento." };
  }
  if (batchId && !(await supabase.from("registration_batches").select("id", { count: "exact", head: true }).eq("id", batchId).eq("event_id", participant.event_id)).count) {
    return { success: false as const, message: "Lote inválido para este evento." };
  }
  const { data, error } = await supabase.rpc("resolve_ticket_data_issues", {
    p_order_item_id: orderItemId,
    p_expected_issue_ids: input.expectedIssueIds,
    p_values: { ...rpcValues, ...(categoryId ? { category: categoryId } : {}), ...(batchId ? { batch: batchId } : {}) },
  });

  if (error) return { success: false as const, message: error.message };

  const result = data as {
    success?: boolean;
    conflict?: boolean;
    message?: string;
    base_amount?: number | null;
    final_amount?: number | null;
    payment_status?: string;
    remaining_issues?: Array<Record<string, unknown>>;
  } | null;

  if (!result?.success) {
    return {
      success: false as const,
      conflict: Boolean(result?.conflict),
      message: result?.message ?? "Nao foi possivel resolver as pendencias.",
    };
  }

  const resolvedFields = Object.keys(input.values);
  const { data: finalizationData, error: finalizationError } = await supabase.rpc(
    "finalize_imported_ticket_after_issue_resolution",
    { p_order_item_id: orderItemId, p_resolved_fields: resolvedFields },
  );
  if (finalizationError) return { success: false as const, message: finalizationError.message };
  const finalization = finalizationData as {
    applicable?: boolean;
    finalization?: "paid_and_ticket_issued" | "payment_pending" | "issues_remaining" | "not_imported";
    ticket_id?: string | null;
    payment_id?: string | null;
    order_id?: string | null;
    order_item_id?: string | null;
  } | null;

  revalidatePath("/inscricoes");
  revalidatePath(`/inscricoes/${input.participantId}`);
  revalidatePath("/operacoes");
  revalidatePath("/cadastros");

  const message = finalization?.finalization === "paid_and_ticket_issued"
    ? "Dados concluídos e ingresso emitido."
    : finalization?.finalization === "payment_pending"
      ? "Dados concluídos. Pagamento aguardando confirmação."
      : result.message ?? "Dados atualizados e reavaliados.";

  return {
    success: true as const,
    message,
    baseAmount: result.base_amount ?? null,
    finalAmount: result.final_amount ?? null,
    paymentStatus: result.payment_status ?? "pending",
    remainingIssues: result.remaining_issues ?? [],
    finalization: finalization?.finalization ?? null,
    ticketId: finalization?.ticket_id ?? null,
    paymentId: finalization?.payment_id ?? null,
    orderId: finalization?.order_id ?? null,
    orderItemId: finalization?.order_item_id ?? null,
  };
}

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

  const { count: blockingIssueCount, error: blockingIssueError } = await supabase
    .from("participant_data_issues")
    .select("id", { count: "exact", head: true })
    .eq("participant_id", participantId)
    .eq("status", "open")
    .eq("blocks_payment", true);
  if (blockingIssueError) return { success: false, message: blockingIssueError.message };
  if ((blockingIssueCount ?? 0) > 0) {
    return { success: false, message: "Complete os dados pendentes antes de confirmar o pagamento." };
  }

  const { data: participant, error: participantError } = await supabase
    .from("participants")
    .select("id, event_id, registration_status")
    .eq("id", participantId)
    .maybeSingle();

  if (participantError) return { success: false, message: participantError.message };
  if (!participant?.id) return { success: false, message: "Participante nao encontrado." };
  const { data: activeItems, error: activeItemError } = await supabase.from("order_items")
    .select("id,order_id,orders!inner(import_batch_id,buyer_type)").eq("participant_id", participantId)
    .eq("event_id", participant.event_id).not("status", "in", "(cancelled,expired,refunded)").limit(2);
  if (activeItemError) return { success: false, message: activeItemError.message };
  if (activeItems?.length !== 1) return { success: false, message: "Abra o ingresso correto para confirmar o pagamento." };
  const activeItem = activeItems[0];

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

  const { count: importedHistoryCount, error: importedHistoryError } = await supabase
    .from("participation_history")
    .select("id", { count: "exact", head: true })
    .eq("participant_id", participantId)
    .eq("event_id", participant.event_id)
    .eq("source", "import")
    .not("import_batch_id", "is", null);
  if (importedHistoryError) return { success: false, message: importedHistoryError.message };

  if ((importedHistoryCount ?? 0) > 0) {
    const { data: importedResult, error: importedError } = await supabase.rpc(
      "finalize_imported_ticket_after_issue_resolution",
      { p_order_item_id: activeItem.id, p_resolved_fields: [], p_force_confirm: true },
    );
    if (importedError) return { success: false, message: importedError.message };
    const finalized = importedResult as { ticket_id?: string | null } | null;
    revalidatePath("/painel");
    revalidatePath("/inscricoes");
    revalidatePath(`/inscricoes/${participantId}`);
    revalidatePath("/operacoes");
    return finalized?.ticket_id
      ? { success: true, message: "Pagamento confirmado e ingresso emitido." }
      : { success: false, message: "Pagamento confirmado, mas o ingresso nao foi emitido." };
  }

  const { error: rpcError } = await supabase.rpc("simulate_payment_paid", {
    p_participant_id: participantId,
    p_payment_method: method,
  });
  if (rpcError) return { success: false, message: rpcError.message };

  const { error: confirmError } = await supabase.rpc("confirm_order_and_issue_ticket", {
    p_participant_id: participantId,
  });
  if (confirmError) return { success: false, message: confirmError.message };

  revalidatePath("/painel");
  revalidatePath("/inscricoes");
  revalidatePath(`/inscricoes/${participantId}`);

  return { success: true, message: "Pagamento confirmado e ingresso emitido." };
}

export async function changeParticipantShirtAction(input: {
  ticketId: string;
  shirtType: string;
  shirtSize: string;
}) {
  await assertPermission("inventory.change_participant_shirt");

  const supabase = await createServerSupabaseClient();
  const shirtType = normalizeShirtType(input.shirtType);
  const shirtSize = normalizeShirtSize(input.shirtSize);

  if (!shirtType || !shirtSize) {
    return { success: false, message: "Modelo/tamanho inválidos." };
  }

  const { error } = await supabase.rpc("change_ticket_shirt", {
    p_ticket_id: input.ticketId,
    p_new_shirt_type: shirtType,
    p_new_shirt_size: shirtSize,
  });
  if (error) return { success: false, message: error.message };

  revalidatePath("/inscricoes");

  return { success: true, message: "Camiseta alterada com sucesso." };
}

export async function resendParticipantTicketAction(participantId: string) {
  await assertPermission("orders.resend_ticket");

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: participant, error: participantError } = await supabase
    .from("participants")
    .select("id, event_id, organization_id, full_name, email, payment_status, registration_status, ticket_categories(name)")
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
    .select("id, token, status")
    .eq("participant_id", participantId)
    .maybeSingle();
  if (ticketError) return { success: false, message: ticketError.message };
  if (!ticket?.token) return { success: false, message: "Ingresso ainda nao emitido." };
  if (ticket.status === "cancelled") return { success: false, message: "Ingresso cancelado nao pode ser reenviado." };

  const { data: eventData } = await supabase
    .from("events")
    .select("name, starts_at, location")
    .eq("id", participant.event_id)
    .maybeSingle();

  const { data: kitItems } = await supabase.rpc("get_ticket_kit_items", {
    p_ticket_id: ticket.id,
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

  const { error: auditError } = await supabase.from("audit_logs").insert({
    action: "ticket_resent",
    entity_type: "tickets",
    entity_id: ticket.id,
    event_id: participant.event_id,
    details: { actor_user_id: user?.id ?? null, organization_id: participant.organization_id, participant_id: participant.id, channel: "email" },
  });
  if (auditError) return { success: false, message: "Ingresso enviado, mas a auditoria do reenvio falhou." };

  return { success: true, message: "Ingresso reenviado por e-mail." };
}

// ─── Comentário: admin_update_payment_status na migration 076 é a proteção final.
// A action TypeScript valida + repassa; o RPC revalida tudo no servidor com SELECT FOR UPDATE.

export async function updateParticipantPaymentStatusAction(
  input: UpdatePaymentStatusInput,
): Promise<{ success: boolean; message: string }> {
  const { participantId, paymentId, expectedCurrentStatus, newStatus, reason } = input;

  await assertPermission(newStatus === "refunded" ? "finance.refund" : "finance.confirm_payment");

  if (!participantId || !paymentId || !newStatus) {
    return { success: false, message: "Dados inválidos." };
  }
  if (!reason.trim() || reason.trim().length < 3) {
    return { success: false, message: "Motivo obrigatório (mínimo 3 caracteres)." };
  }

  const supabase = await createServerSupabaseClient();

  if (newStatus === "paid") {
    const { count, error: issueError } = await supabase
      .from("participant_data_issues")
      .select("id", { count: "exact", head: true })
      .eq("participant_id", participantId)
      .eq("status", "open")
      .eq("blocks_payment", true);

    if (issueError) return { success: false, message: issueError.message };
    if ((count ?? 0) > 0) {
      return { success: false, message: "Complete os dados pendentes antes de confirmar o pagamento." };
    }
  }

  const { data, error } = await supabase.rpc("admin_update_payment_status", {
    p_payment_id: paymentId,
    p_participant_id: participantId,
    p_expected_current_status: expectedCurrentStatus,
    p_new_status: newStatus,
    p_reason: reason.trim(),
  });

  if (error) return { success: false, message: error.message };

  const result = data as { success: boolean; message: string } | null;
  if (!result?.success) {
    return { success: false, message: result?.message ?? "Erro ao alterar status." };
  }

  revalidatePath("/inscricoes");
  revalidatePath(`/inscricoes/${participantId}`);
  revalidatePath("/financeiro");

  return { success: true, message: result.message ?? "Status alterado com sucesso." };
}
