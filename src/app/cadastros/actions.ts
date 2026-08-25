"use server";

import { revalidatePath } from "next/cache";
import { assertPermission, hasPermission } from "@/lib/admin/permissions";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resendParticipantTicketAction } from "@/app/inscricoes/actions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ADMIN_DELETE_REASONS = new Set(["incorrect_issue", "duplicate", "cancelled_order", "incorrect_registration", "system_test", "administrative_correction", "other"]);

async function assertCurrentOrganizationOwner() {
  const context = await getCurrentOrganizationContext();
  if (!context.organization?.id || !context.isOrgOwner) throw new Error("Somente o Owner da organização pode executar esta ação.");
  return context.organization.id;
}

function validateAdministrativeDeleteReason(reasonCode: string, reasonText?: string) {
  if (!ADMIN_DELETE_REASONS.has(reasonCode)) return "Selecione um motivo válido.";
  if (reasonCode === "other" && !reasonText?.trim()) return "Descreva o motivo da exclusão.";
  return null;
}

export async function cancelCadastroTicketAction(payload: { contactId: string; ticketId: string; reasonCode: string; reasonText?: string }) {
  try { await assertCurrentOrganizationOwner(); } catch (error) { return { success: false as const, message: error instanceof Error ? error.message : "Sem permissão." }; }
  if (![payload.contactId, payload.ticketId].every((value) => UUID_PATTERN.test(value))) return { success: false as const, message: "Cadastro ou ingresso inválido." };
  const reasonError = validateAdministrativeDeleteReason(payload.reasonCode, payload.reasonText);
  if (reasonError) return { success: false as const, message: reasonError };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("owner_cancel_ticket", { p_ticket_id: payload.ticketId, p_reason_code: payload.reasonCode, p_reason_text: payload.reasonText?.trim() || null });
  if (error) return { success: false as const, message: error.message };
  revalidatePath(`/cadastros/${payload.contactId}`);
  revalidatePath(`/ingressos/${payload.ticketId}`);
  return { success: true as const, message: "Ingresso cancelado com sucesso." };
}

export async function cancelCadastroAdditionalItemAction(payload: { contactId: string; itemId: string; reasonCode: string; reasonText?: string }) {
  try { await assertCurrentOrganizationOwner(); } catch (error) { return { success: false as const, message: error instanceof Error ? error.message : "Sem permissão." }; }
  if (![payload.contactId, payload.itemId].every((value) => UUID_PATTERN.test(value))) return { success: false as const, message: "Cadastro ou item inválido." };
  const reasonError = validateAdministrativeDeleteReason(payload.reasonCode, payload.reasonText);
  if (reasonError) return { success: false as const, message: reasonError };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("owner_cancel_store_order_item", { p_store_order_item_id: payload.itemId, p_reason_code: payload.reasonCode, p_reason_text: payload.reasonText?.trim() || null });
  if (error) return { success: false as const, message: error.message };
  revalidatePath(`/cadastros/${payload.contactId}`);
  return { success: true as const, message: "Item adicional cancelado com sucesso." };
}

async function assertStoreGrantPermission() {
  if (await hasPermission("store.grant_items")) return;
  await assertPermission("store.manage");
}

export async function grantStoreItemToContactAction(payload: {
  contactId: string;
  eventId: string;
  storeItemId: string;
  variantId: string | null;
  quantity: number;
  isCourtesy: boolean;
  reason?: string;
}) {
  await assertStoreGrantPermission();
  if (![payload.contactId, payload.eventId, payload.storeItemId].every((value) => UUID_PATTERN.test(value))) {
    return { success: false as const, message: "Cadastro, evento ou produto inválido." };
  }
  if (payload.variantId && !UUID_PATTERN.test(payload.variantId)) {
    return { success: false as const, message: "Variante inválida." };
  }
  if (!Number.isInteger(payload.quantity) || payload.quantity <= 0) {
    return { success: false as const, message: "Quantidade inválida." };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("admin_grant_store_item_to_contact", {
    p_contact_id: payload.contactId,
    p_event_id: payload.eventId,
    p_store_item_id: payload.storeItemId,
    p_variant_id: payload.variantId,
    p_quantity: payload.quantity,
    p_is_courtesy: payload.isCourtesy,
    p_reason: payload.reason?.trim() || null,
  });
  if (error) return { success: false as const, message: error.message };

  revalidatePath(`/cadastros/${payload.contactId}`);
  return { success: true as const, message: "Item concedido com sucesso." };
}

function firstAccessInviteRedirect(inviteId: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const destination = `/primeiro-acesso?invite=${encodeURIComponent(inviteId)}&next=${encodeURIComponent("/minha-conta/ingressos")}`;
  return `${appUrl}/auth/callback?next=${encodeURIComponent(destination)}`;
}

type EligibilityRpcRow = { eligible?: boolean; reason_code?: string; reason_message?: string; email?: string | null };

async function dispatchFirstAccessEmail(input: { inviteId: string; email: string; reasonCode: string }) {
  const admin = createServiceRoleSupabaseClient();
  const isResend = input.reasonCode.startsWith("resend_invite_");
  const redirectTo = firstAccessInviteRedirect(input.inviteId);

  const { data: invitePerson } = await admin.from("participant_account_invites")
    .select("registration_contacts(full_name),participants(registration_contacts(full_name))")
    .eq("id", input.inviteId).maybeSingle();
  const directContactRelation = Array.isArray(invitePerson?.registration_contacts) ? invitePerson.registration_contacts[0] : invitePerson?.registration_contacts;
  const participantRelation = Array.isArray(invitePerson?.participants) ? invitePerson?.participants[0] : invitePerson?.participants;
  const contactRelation = Array.isArray(participantRelation?.registration_contacts) ? participantRelation?.registration_contacts[0] : participantRelation?.registration_contacts;
  const canonicalFullName = String(directContactRelation?.full_name ?? contactRelation?.full_name ?? "").trim();

  if (isResend) {
    const result = await admin.auth.signInWithOtp({
      email: input.email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
    });
    return { error: result.error, authUserId: null as string | null, resent: true };
  }

  const result = await admin.auth.admin.inviteUserByEmail(input.email, {
    redirectTo,
    data: { participant_invite_id: input.inviteId, ...(canonicalFullName ? { full_name: canonicalFullName } : {}) },
  });
  return { error: result.error, authUserId: result.data.user?.id ?? null, resent: false };
}

export async function inviteCadastroFirstAccessAction(id: string, anchor: "participant" | "contact" = "participant") {
  await assertPermission("participants.edit_basic");
  const supabase = await createServerSupabaseClient();
  if (!UUID_PATTERN.test(id)) return { success: false as const, message: "Cadastro invalido." };
  const eligibilityResult = anchor === "contact"
    ? await supabase.rpc("check_registration_contact_account_invite_eligibility", { p_registration_contact_id: id })
    : await supabase.rpc("check_participant_account_invite_eligibility", { p_participant_id: id });
  const eligibility = (Array.isArray(eligibilityResult.data) ? eligibilityResult.data[0] : eligibilityResult.data) as EligibilityRpcRow | null;
  if (eligibilityResult.error || !eligibility?.eligible) {
    const reasonCode = eligibilityResult.error ? "evaluation_error" : String(eligibility?.reason_code ?? "account_conflict");
    return { success: false as const, inviteState: reasonCode === "already_linked" ? "linked" as const : "conflict" as const, reasonCode, message: eligibilityResult.error?.message ?? String(eligibility?.reason_message ?? "Cadastro não elegível.") };
  }
  const { data, error } = anchor === "contact"
    ? await supabase.rpc("prepare_registration_contact_account_invite", { p_registration_contact_id: id })
    : await supabase.rpc("prepare_participant_account_invite", { p_participant_id: id });
  if (error) return { success: false as const, message: error.message };
  const prepared = (Array.isArray(data) ? data[0] : data) as { invite_id?: string; email?: string } | null;
  if (!prepared?.invite_id || !prepared.email) return { success: false as const, message: "Convite não preparado." };
  const reasonCode = String(eligibility.reason_code ?? "eligible");
  const invited = await dispatchFirstAccessEmail({ inviteId: prepared.invite_id, email: prepared.email, reasonCode });
  if (invited.error) return { success: true as const, prepared: true, sent: false, message: `Convite preparado, mas o provedor não aceitou o envio: ${invited.error.message}` };
  if (invited.authUserId) {
    const admin = createServiceRoleSupabaseClient();
    const association = await admin.from("participant_account_invites").update({
      auth_user_id: invited.authUserId,
      updated_at: new Date().toISOString(),
    }).eq("id", prepared.invite_id);
    if (association.error) return { success: true as const, prepared: true, sent: true, inviteState: "resend" as const, message: "Convite enviado, mas a correlação da conta exige a migration 099 antes de um futuro reenvio." };
  }
  revalidatePath("/cadastros");
  if (anchor === "contact") revalidatePath(`/cadastros/${id}`);
  return { success: true as const, prepared: true, sent: true, inviteState: "resend" as const, message: invited.resent ? "Convite de primeiro acesso reenviado." : "Convite preparado e envio aceito pelo provedor." };
}

export async function bulkResolveImportCategoryBatchAction(input: { importBatchId: string; participantIds: string[]; categoryId: string; batchId: string }) {
  await assertPermission("participants.edit_basic");
  const participantIds = [...new Set(input.participantIds)].slice(0, 1000);
  if (!participantIds.length || !input.categoryId || !input.batchId) return { success: false as const, message: "Selecione cadastros, categoria e lote." };
  const supabase = await createServerSupabaseClient();
  const { data: batch } = await supabase.from("import_batches").select("id,event_id,payment_mode_original").eq("id", input.importBatchId).single();
  if (!batch?.event_id) return { success: false as const, message: "Lote de importação inválido." };
  const [{ count: categoryCount }, { count: batchCount }, { count: priceCount }] = await Promise.all([
    supabase.from("ticket_categories").select("id", { count: "exact", head: true }).eq("id", input.categoryId).eq("event_id", batch.event_id).eq("is_active", true),
    supabase.from("registration_batches").select("id", { count: "exact", head: true }).eq("id", input.batchId).eq("event_id", batch.event_id).eq("is_active", true),
    supabase.from("registration_batch_prices").select("id", { count: "exact", head: true }).eq("batch_id", input.batchId).eq("ticket_category_id", input.categoryId),
  ]);
  if (!categoryCount || !batchCount || !priceCount) return { success: false as const, message: "Categoria/lote inválidos ou sem preço compatível." };
  const { data: eligible, error } = await supabase.from("participant_data_issues").select("participant_id,order_item_id").eq("import_batch_id", input.importBatchId).eq("status", "open").in("field_code", ["category", "batch", "price"]).in("participant_id", participantIds);
  if (error) return { success: false as const, message: error.message };
  const eligibleItems = [...new Map((eligible ?? []).filter((row) => row.order_item_id).map((row) => [String(row.order_item_id), String(row.participant_id)])).entries()];
  let applied = 0; let remaining = 0; let finalized = 0; const failures: string[] = [];
  for (const [orderItemId, participantId] of eligibleItems) {
    const updated = await supabase.rpc("resolve_import_ticket_options", { p_order_item_id: orderItemId, p_ticket_category_id: input.categoryId, p_batch_id: input.batchId });
    if (updated.error) { failures.push(participantId); continue; }
    applied += 1;
    const { count } = await supabase.from("participant_data_issues").select("id", { count: "exact", head: true }).eq("order_item_id", orderItemId).eq("status", "open").or("blocks_payment.eq.true,blocks_ticket_issuance.eq.true");
    if (count) { remaining += 1; continue; }
    if (batch.payment_mode_original === "confirm_all") {
      const result = await supabase.rpc("finalize_imported_ticket_after_issue_resolution", { p_order_item_id: orderItemId, p_resolved_fields: ["category", "batch"], p_force_confirm: true });
      if (result.error) failures.push(participantId); else finalized += 1;
    }
  }
  revalidatePath("/cadastros"); revalidatePath("/importacoes"); revalidatePath("/operacoes");
  return { success: true as const, message: `${applied} cadastro(s) reavaliado(s). ${remaining} permanecem com bloqueios. ${finalized} ingresso(s) finalizado(s).${failures.length ? ` ${failures.length} exigem revisão individual.` : ""}`, applied, remaining, finalized, failures: failures.length };
}

type InviteEligibility = { participantId: string; eligible: boolean; reasonCode: string; reasonMessage: string; email: string | null };

export async function previewBulkFirstAccessInvitesAction(participantIds: string[]) {
  await assertPermission("participants.edit_basic");
  const supabase = await createServerSupabaseClient();
  const ids = [...new Set(participantIds)].slice(0, 1000);
  const results: InviteEligibility[] = [];
  for (const participantId of ids) {
    const { data, error } = await supabase.rpc("check_participant_account_invite_eligibility", { p_participant_id: participantId });
    const row = (Array.isArray(data) ? data[0] : data) as EligibilityRpcRow | null;
    results.push({ participantId, eligible: !error && Boolean(row?.eligible), reasonCode: error ? "evaluation_error" : String(row?.reason_code ?? "other"), reasonMessage: error?.message ?? String(row?.reason_message ?? "Motivo não informado."), email: row?.email ?? null });
  }
  const reasons = results.filter((item) => !item.eligible).reduce<Record<string, number>>((all, item) => ({ ...all, [item.reasonCode]: (all[item.reasonCode] ?? 0) + 1 }), {});
  return { success: true as const, total: results.length, eligible: results.filter((item) => item.eligible).length, reasons, results };
}

export async function sendBulkFirstAccessInvitesAction(participantIds: string[]) {
  await assertPermission("participants.edit_basic");
  const preview = await previewBulkFirstAccessInvitesAction(participantIds);
  const supabase = await createServerSupabaseClient(); const admin = createServiceRoleSupabaseClient();
  const report = { prepared: 0, sent: 0, ignored: preview.total - preview.eligible, failed: 0, reasons: { ...preview.reasons } as Record<string, number>, details: [] as Array<{ participantId: string; status: string; reason: string }> };
  for (const item of preview.results) {
    if (!item.eligible) { report.details.push({ participantId: item.participantId, status: "ignored", reason: item.reasonMessage }); continue; }
    const { data, error } = await supabase.rpc("prepare_participant_account_invite", { p_participant_id: item.participantId });
    const prepared = (Array.isArray(data) ? data[0] : data) as { invite_id?: string; email?: string } | null;
    if (error || !prepared?.invite_id || !prepared.email) { report.failed += 1; const reason = error?.message ?? "Convite não preparado."; report.reasons.prepare_failed = (report.reasons.prepare_failed ?? 0) + 1; report.details.push({ participantId: item.participantId, status: "failed", reason }); continue; }
    report.prepared += 1;
    const sent = await dispatchFirstAccessEmail({ inviteId: prepared.invite_id, email: prepared.email, reasonCode: item.reasonCode });
    if (sent.error) { report.failed += 1; report.reasons.email_dispatch_failed = (report.reasons.email_dispatch_failed ?? 0) + 1; report.details.push({ participantId: item.participantId, status: "prepared_not_sent", reason: sent.error.message }); }
    else {
      if (sent.authUserId) {
        const association = await admin.from("participant_account_invites").update({
          auth_user_id: sent.authUserId,
          updated_at: new Date().toISOString(),
        }).eq("id", prepared.invite_id);
        if (association.error) { report.failed += 1; report.reasons.association_failed = (report.reasons.association_failed ?? 0) + 1; report.details.push({ participantId: item.participantId, status: "sent_association_failed", reason: association.error.message }); continue; }
      }
      report.sent += 1; report.details.push({ participantId: item.participantId, status: sent.resent ? "resent" : "sent", reason: sent.resent ? "Convite de primeiro acesso reenviado." : "Convite preparado e envio aceito pelo provedor." });
    }
  }
  revalidatePath("/cadastros");
  return { success: true as const, report };
}

type ImportInvitePreview = {
  total_count: number; eligible_count: number; already_linked_count: number;
  invalid_email_count: number; recently_invited_count: number; other_skipped_count: number;
};

export async function previewImportAccountInviteJobAction(importBatchId: string) {
  await assertPermission("participants.edit_basic");
  if (!UUID_PATTERN.test(importBatchId)) return { success: false as const, message: "Importação inválida." };
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("preview_import_account_invites", { p_import_batch_id: importBatchId });
  if (error) return { success: false as const, message: error.message };
  const row = (Array.isArray(data) ? data[0] : data) as ImportInvitePreview | null;
  if (!row) return { success: false as const, message: "Importação concluída não encontrada." };
  return { success: true as const, preview: row };
}

export async function startImportAccountInviteJobAction(importBatchId: string) {
  await assertPermission("participants.edit_basic");
  if (!UUID_PATTERN.test(importBatchId)) return { success: false as const, message: "Importação inválida." };
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("start_import_account_invite_job", { p_import_batch_id: importBatchId });
  if (error || !data) return { success: false as const, message: error?.message ?? "Não foi possível iniciar os convites." };
  return { success: true as const, jobId: String(data) };
}

export async function getImportAccountInviteJobAction(jobId: string) {
  await assertPermission("participants.edit_basic");
  if (!UUID_PATTERN.test(jobId)) return { success: false as const, message: "Job inválido." };
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("account_invite_jobs").select("id,status,total_count,eligible_count,processed_count,sent_count,skipped_count,failed_count").eq("id", jobId).maybeSingle();
  if (error || !data) return { success: false as const, message: error?.message ?? "Job não encontrado." };
  return { success: true as const, job: data };
}

export async function processImportAccountInviteJobChunkAction(jobId: string) {
  await assertPermission("participants.edit_basic");
  if (!UUID_PATTERN.test(jobId)) return { success: false as const, message: "Job inválido." };
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("claim_account_invite_job_items", { p_job_id: jobId, p_limit: 25 });
  if (error) return { success: false as const, message: error.message };
  const items = (data ?? []) as Array<{ item_id: string; participant_id: string }>;
  for (const item of items) {
    const turnResult = await supabase.rpc("check_account_invite_job_item_turn", { p_item_id: item.item_id });
    const turn = (Array.isArray(turnResult.data) ? turnResult.data[0] : turnResult.data) as { allowed?: boolean; reason_code?: string } | null;
    if (turnResult.error || !turn?.allowed) {
      const reason = turnResult.error ? "turn_evaluation_error" : String(turn?.reason_code ?? "concurrent_invite");
      const skipped = await supabase.rpc("finish_account_invite_job_item", { p_item_id: item.item_id, p_status: turnResult.error ? "failed" : "skipped", p_reason_code: reason });
      if (skipped.error) return { success: false as const, message: skipped.error.message };
      continue;
    }
    const result = await inviteCadastroFirstAccessAction(String(item.participant_id));
    const status = result.success && result.sent ? "sent" : "prepared" in result && result.prepared ? "failed" : "skipped";
    const reasonCode = "reasonCode" in result && result.reasonCode
      ? String(result.reasonCode)
      : status === "failed" ? "provider_or_prepare_error" : "not_eligible";
    const finished = await supabase.rpc("finish_account_invite_job_item", { p_item_id: item.item_id, p_status: status, p_reason_code: reasonCode });
    if (finished.error) return { success: false as const, message: finished.error.message };
  }
  return getImportAccountInviteJobAction(jobId);
}

export async function retryImportAccountInviteJobFailuresAction(jobId: string) {
  await assertPermission("participants.edit_basic");
  if (!UUID_PATTERN.test(jobId)) return { success: false as const, message: "Job inválido." };
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("retry_failed_account_invite_job", { p_job_id: jobId });
  if (error) return { success: false as const, message: error.message };
  return { success: true as const, retried: Number(data ?? 0) };
}

export async function listImportAccountInviteJobFailuresAction(jobId: string) {
  await assertPermission("participants.edit_basic");
  if (!UUID_PATTERN.test(jobId)) return { success: false as const, message: "Job inválido." };
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("account_invite_job_items")
    .select("id,error_code,attempt_count,participants(registration_contacts(full_name,email))")
    .eq("job_id", jobId).eq("status", "failed").order("created_at").limit(200);
  if (error) return { success: false as const, message: error.message };
  return { success: true as const, failures: data ?? [] };
}

export type FinalizeCadastroInput = {
  participantId: string;
  paymentId: string;
  eventId: string;
  organizationId: string;
};

export async function finalizeCadastroPaymentAndTicketAction(input: FinalizeCadastroInput) {
  await assertPermission("finance.confirm_payment");
  const supabase = await createServerSupabaseClient();
  const finalized = await supabase.rpc("finalize_cadastro_payment_and_ticket", {
    p_participant_id: input.participantId, p_payment_id: input.paymentId,
    p_event_id: input.eventId, p_organization_id: input.organizationId,
  });
  if (finalized.error) return { success: false as const, message: finalized.error.message };
  const result = finalized.data as Record<string, unknown> | null;
  if (!result?.success) return { success: false as const, message: "A finalização protegida não retornou sucesso." };
  const paymentId = String(result.payment_id ?? ""); const orderId = String(result.order_id ?? "");
  const orderItemId = String(result.order_item_id ?? ""); const ticketId = String(result.ticket_id ?? "");
  if (![paymentId, orderId, orderItemId, ticketId].every(Boolean)) return { success: false as const, message: "A finalização protegida retornou identificadores incompletos." };

  revalidatePath("/cadastros"); revalidatePath("/inscricoes"); revalidatePath(`/inscricoes/${input.participantId}`);
  return { success: true as const, message: "Pagamento confirmado e ingresso disponível.", paymentId, orderId, orderItemId, ticketId };
}

export async function assignParticipantRoleAction(input: { userId: string; roleId: string | null }) {
  await assertPermission("team.edit_permissions");
  const supabase = await createServerSupabaseClient();

  const { data: profileRows, error: profileError } = await supabase.rpc("get_admin_user_profile", { p_user_id: input.userId });
  if (profileError) return { success: false as const, message: profileError.message };
  const profile = (Array.isArray(profileRows) ? profileRows[0] : profileRows) as { is_active?: boolean; internal_note?: string | null } | null;

  const { data: overrideRows, error: overrideError } = await supabase.rpc("list_override_state_for_user", { p_user_id: input.userId });
  if (overrideError) return { success: false as const, message: overrideError.message };
  const overrides = (overrideRows ?? []).map((item: Record<string, unknown>) => ({
    permission_code: String(item.permission_code ?? ""),
    effect: String(item.effect ?? "") === "deny" ? "deny" : "allow",
  })).filter((item: { permission_code: string }) => item.permission_code);

  const { error } = await supabase.rpc("upsert_admin_user_access", {
    p_target_user_id: input.userId,
    p_role_id: input.roleId,
    p_is_active: profile?.is_active ?? true,
    p_internal_note: profile?.internal_note ?? null,
    p_overrides: overrides,
    p_reason: "Funcao atribuida a partir da tela de Cadastros",
  });
  if (error) return { success: false as const, message: error.message };

  revalidatePath("/cadastros");
  revalidatePath("/painel/configuracoes/equipe");
  revalidatePath(`/painel/configuracoes/equipe/${input.userId}`);
  return { success: true as const, message: input.roleId ? "Função atribuída." : "Função removida." };
}

export async function resendCadastroTicketAction(input: FinalizeCadastroInput & { orderId: string; orderItemId: string; ticketId: string }) {
  await assertPermission("orders.resend_ticket");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("tickets")
    .select("id,participant_id,event_id,organization_id,order_id,order_item_id,orders!inner(payment_id)")
    .eq("id", input.ticketId).eq("participant_id", input.participantId)
    .eq("event_id", input.eventId).eq("organization_id", input.organizationId)
    .eq("order_id", input.orderId).eq("order_item_id", input.orderItemId)
    .eq("orders.payment_id", input.paymentId).maybeSingle();
  if (error || !data) return { success: false as const, message: error?.message ?? "Ingresso não corresponde simultaneamente ao cadastro, pagamento, evento e organização." };
  return resendParticipantTicketAction(input.participantId);
}
