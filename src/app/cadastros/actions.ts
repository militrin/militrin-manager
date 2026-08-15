"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/admin/permissions";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { resendParticipantTicketAction } from "@/app/inscricoes/actions";

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

  if (isResend) {
    const result = await admin.auth.signInWithOtp({
      email: input.email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
    });
    return { error: result.error, authUserId: null as string | null, resent: true };
  }

  const result = await admin.auth.admin.inviteUserByEmail(input.email, {
    redirectTo,
    data: { participant_invite_id: input.inviteId },
  });
  return { error: result.error, authUserId: result.data.user?.id ?? null, resent: false };
}

export async function inviteCadastroFirstAccessAction(participantId: string) {
  await assertPermission("participants.edit_basic");
  const supabase = await createServerSupabaseClient();
  const eligibilityResult = await supabase.rpc("check_participant_account_invite_eligibility", { p_participant_id: participantId });
  const eligibility = (Array.isArray(eligibilityResult.data) ? eligibilityResult.data[0] : eligibilityResult.data) as EligibilityRpcRow | null;
  if (eligibilityResult.error || !eligibility?.eligible) {
    const reasonCode = eligibilityResult.error ? "evaluation_error" : String(eligibility?.reason_code ?? "account_conflict");
    return { success: false as const, inviteState: reasonCode === "already_linked" ? "linked" as const : "conflict" as const, reasonCode, message: eligibilityResult.error?.message ?? String(eligibility?.reason_message ?? "Cadastro não elegível.") };
  }
  const { data, error } = await supabase.rpc("prepare_participant_account_invite", { p_participant_id: participantId });
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
  const { data: eligible, error } = await supabase.from("participant_data_issues").select("participant_id").eq("import_batch_id", input.importBatchId).eq("status", "open").in("field_code", ["category", "batch", "price"]).in("participant_id", participantIds);
  if (error) return { success: false as const, message: error.message };
  const eligibleIds = [...new Set((eligible ?? []).map((row) => String(row.participant_id)))];
  let applied = 0; let remaining = 0; let finalized = 0; const failures: string[] = [];
  for (const participantId of eligibleIds) {
    const updated = await supabase.from("participants").update({ ticket_category_id: input.categoryId, batch_id: input.batchId, updated_at: new Date().toISOString() }).eq("id", participantId).eq("event_id", batch.event_id);
    if (updated.error) { failures.push(participantId); continue; }
    const reevaluated = await supabase.rpc("reevaluate_participant_data_issues", { p_participant_id: participantId, p_import_batch_id: input.importBatchId });
    if (reevaluated.error) { failures.push(participantId); continue; }
    applied += 1;
    const { count } = await supabase.from("participant_data_issues").select("id", { count: "exact", head: true }).eq("participant_id", participantId).eq("status", "open").or("blocks_payment.eq.true,blocks_ticket_issuance.eq.true");
    if (count) { remaining += 1; continue; }
    if (batch.payment_mode_original === "confirm_all") {
      const result = await supabase.rpc("finalize_imported_participant_after_issue_resolution", { p_participant_id: participantId, p_resolved_fields: ["category", "batch"], p_force_confirm: true });
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
