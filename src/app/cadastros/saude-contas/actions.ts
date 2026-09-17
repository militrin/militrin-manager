"use server";

import { revalidatePath } from "next/cache";
import { assertPermission, hasPermission } from "@/lib/admin/permissions";
import {
  ACCOUNT_HEALTH_PERMISSION,
  accountHealthActionError,
  parseAccountHealthFilter,
  type AccountHealthAction,
  type AccountHealthCaseDetail,
  type AccountHealthListPayload,
} from "@/lib/account/account-health";
import { isPendingEmailConfirmationReason } from "@/lib/account/contact-account-state";
import { resendSignupConfirmation } from "@/lib/account/resend-signup-confirmation";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { inviteCadastroFirstAccessAction } from "@/app/cadastros/actions";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AccountHealthQuery = {
  state?: string | null;
  q?: string | null;
  page?: string | null;
  pageSize?: string | null;
};

function pageSizeFrom(value: string | null | undefined) {
  const parsed = Number(value);
  if (parsed === 50 || parsed === 100) return parsed;
  return 25;
}

async function requireHealthView() {
  await assertPermission(ACCOUNT_HEALTH_PERMISSION);
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) throw new Error("Selecione uma organização.");
  return { organization, canAct: await hasPermission("participants.edit_basic") };
}

async function loadCase(caseId: string) {
  const { organization } = await requireHealthView();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_account_health_case", {
    p_case_id: caseId,
    p_organization_id: organization.id,
  });
  if (error) return { success: false as const, message: error.message, organizationId: organization.id };
  return { success: true as const, data: data as AccountHealthCaseDetail, organizationId: organization.id };
}

async function recordHealthAction(input: {
  action: string;
  contactId: string | null;
  caseId: string;
  previousState: string | null;
  organizationId: string;
}) {
  const supabase = await createServerSupabaseClient();
  const user = (await supabase.auth.getUser()).data.user;
  await supabase.from("audit_logs").insert({
    action: input.action,
    entity_type: "account_health_cases",
    entity_id: input.contactId && UUID_PATTERN.test(input.contactId) ? input.contactId : null,
    details: {
      organization_id: input.organizationId,
      registration_contact_id: input.contactId,
      case_id: input.caseId,
      actor_user_id: user?.id ?? null,
      previous_state: input.previousState,
    },
  });
}

export async function loadAccountHealth(query: AccountHealthQuery) {
  try {
    const { organization, canAct } = await requireHealthView();
    const supabase = await createServerSupabaseClient();
    const page = Math.max(1, Number(query.page || 1) || 1);
    const pageSize = pageSizeFrom(query.pageSize);
    const { data, error } = await supabase.rpc("list_account_health_cases", {
      p_organization_id: organization.id,
      p_state: parseAccountHealthFilter(query.state),
      p_search: query.q?.trim() || null,
      p_limit: pageSize,
      p_offset: (page - 1) * pageSize,
    });
    if (error) return { success: false as const, message: error.message, canAct };
    const payload = data as AccountHealthListPayload;
    const canViewOrphans = Boolean(payload?.can_view_orphans);
    if (parseAccountHealthFilter(query.state) === "possible_orphan" && !canViewOrphans) {
      const retried = await supabase.rpc("list_account_health_cases", {
        p_organization_id: organization.id,
        p_state: "all",
        p_search: query.q?.trim() || null,
        p_limit: pageSize,
        p_offset: (page - 1) * pageSize,
      });
      if (retried.error) return { success: false as const, message: retried.error.message, canAct };
      return { success: true as const, data: { ...(retried.data as AccountHealthListPayload), can_view_orphans: false }, canAct };
    }
    return { success: true as const, data: { ...payload, can_view_orphans: canViewOrphans }, canAct };
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : "Sem permissão.", canAct: false };
  }
}

export async function loadAccountHealthCase(caseId: string) {
  try {
    const canAct = await hasPermission("participants.edit_basic");
    const result = await loadCase(caseId);
    if (!result.success) return { ...result, canAct };
    return { ...result, canAct };
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : "Sem permissão.", canAct: false };
  }
}

export async function reanalyzeAccountHealthCaseAction(caseId: string) {
  try {
    const result = await loadCase(caseId);
    if (!result.success) return { success: false as const, message: result.message };
    revalidatePath("/cadastros/saude-contas");
    revalidatePath(`/cadastros/saude-contas/${caseId}`);
    return { success: true as const, message: "Situação atualizada.", data: result.data };
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : "Não foi possível reanalisar." };
  }
}

export async function resendAccountHealthConfirmationAction(caseId: string) {
  try {
    await assertPermission("participants.edit_basic");
    const result = await loadCase(caseId);
    if (!result.success) return { success: false as const, message: result.message };
    const row = result.data.case;
    const contactId = row?.registration_contact_id;
    const actionError = accountHealthActionError(row, "resend_confirmation");
    if (!row || !contactId || actionError || !row.display_email) {
      return { success: false as const, message: actionError ?? "Reenvio de confirmação não disponível para este caso." };
    }
    const supabase = await createServerSupabaseClient();
    const state = await supabase.rpc("get_registration_contact_account_state", {
      p_registration_contact_id: contactId,
    });
    const stateRow = (Array.isArray(state.data) ? state.data[0] : state.data) as {
      can_resend_confirmation?: boolean;
      reason_code?: string;
      email?: string | null;
      reason_message?: string;
    } | null;
    if (state.error || !stateRow?.can_resend_confirmation || !isPendingEmailConfirmationReason(stateRow.reason_code) || !stateRow.email) {
      return { success: false as const, message: stateRow?.reason_message ?? "Reenvio de confirmação não disponível para este cadastro." };
    }
    const resend = await resendSignupConfirmation({ email: stateRow.email, audience: "admin" });
    if (resend.ok) {
      await recordHealthAction({
        action: "account_health_confirmation_resent",
        contactId,
        caseId,
        previousState: row.state,
        organizationId: result.organizationId,
      });
    }
    revalidatePath("/cadastros/saude-contas");
    revalidatePath(`/cadastros/saude-contas/${caseId}`);
    revalidatePath(`/cadastros/${contactId}`);
    return {
      success: resend.ok,
      message: resend.ok ? "Envio de confirmação solicitado." : resend.message,
      rateLimited: resend.rateLimited,
    };
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : "Sem permissão." };
  }
}

async function sendAccountHealthInvite(caseId: string, expectedAction: "send_invite" | "send_access") {
  await assertPermission("participants.edit_basic");
  const result = await loadCase(caseId);
  if (!result.success) return { success: false as const, message: result.message };
  const row = result.data.case;
  const contactId = row?.registration_contact_id;
  const actionError = accountHealthActionError(row, expectedAction);
  if (!row || !contactId || actionError) {
    return { success: false as const, message: actionError ?? "Esta ação não está disponível para o estado atual." };
  }
  const invited = await inviteCadastroFirstAccessAction(contactId, "contact");
  if (invited.success) {
    await recordHealthAction({
      action: expectedAction === "send_access" ? "account_health_access_sent" : "account_health_invite_sent",
      contactId,
      caseId,
      previousState: row.state,
      organizationId: result.organizationId,
    });
  }
  revalidatePath("/cadastros/saude-contas");
  revalidatePath(`/cadastros/saude-contas/${caseId}`);
  revalidatePath(`/cadastros/${contactId}`);
  return {
    success: invited.success,
    message: invited.message,
  };
}

export async function sendAccountHealthInviteAction(caseId: string) {
  try {
    return await sendAccountHealthInvite(caseId, "send_invite");
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : "Sem permissão." };
  }
}

export async function sendAccountHealthAccessAction(caseId: string) {
  try {
    return await sendAccountHealthInvite(caseId, "send_access");
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : "Sem permissão." };
  }
}
