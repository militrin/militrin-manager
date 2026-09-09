"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasPermission } from "@/lib/admin/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { validateTicketAccountOwnerReason } from "@/lib/account/shared-email-ownership";

async function assertCanManageTicketAccountOwner() {
  const allowed = await hasPermission("participants.edit_basic") || await hasPermission("tickets.transfer_ownership");
  if (!allowed) return { ok: false as const, message: "Sem permissão para alterar a conta proprietária." };
  return { ok: true as const };
}

export async function assignSharedEmailAccountOwnerOrgAction(input: {
  primaryContactId: string;
  reasonCode: string;
  reasonText?: string | null;
}) {
  const access = await assertCanManageTicketAccountOwner();
  if (!access.ok) return { success: false as const, message: access.message };
  if (!z.string().uuid().safeParse(input.primaryContactId).success) {
    return { success: false as const, message: "Pessoa inválida." };
  }
  let reason: ReturnType<typeof validateTicketAccountOwnerReason>;
  try {
    reason = validateTicketAccountOwnerReason(input.reasonCode, input.reasonText);
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : "Motivo inválido." };
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("assign_shared_email_account_owner_org", {
    p_primary_contact_id: input.primaryContactId,
    p_reason_code: reason.reasonCode,
    p_reason_text: reason.reasonText,
  });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/cadastros");
  revalidatePath(`/cadastros/${input.primaryContactId}`);
  revalidatePath(`/cadastros/${input.primaryContactId}/conta-compartilhada`);
  revalidatePath("/ingressos");
  revalidatePath("/minha-conta/ingressos");
  const result = (data ?? {}) as { tickets_changed?: number; owner_user_id_materialized?: boolean };
  return {
    success: true as const,
    message: result.owner_user_id_materialized
      ? "Conta principal definida. Os ingressos já estão visíveis para essa conta."
      : "Conta principal definida. A propriedade será concluída após o primeiro acesso.",
    result,
  };
}

export async function searchTicketAccountOwnerContactsAction(ticketId: string, term: string) {
  const access = await assertCanManageTicketAccountOwner();
  if (!access.ok) return { success: false as const, message: access.message, candidates: [] };
  if (!z.string().uuid().safeParse(ticketId).success) {
    return { success: false as const, message: "Ingresso inválido.", candidates: [] };
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("search_admin_ticket_account_owner_contacts", {
    p_ticket_id: ticketId,
    p_term: term,
  });
  if (error) return { success: false as const, message: error.message, candidates: [] };
  return {
    success: true as const,
    message: data?.length ? `${data.length} cadastro(s) encontrado(s).` : "Nenhum cadastro encontrado.",
    candidates: (data ?? []) as Array<{
      registration_contact_id: string;
      full_name: string;
      masked_email: string | null;
      public_pin: string | null;
      has_valid_auth: boolean;
    }>,
  };
}

export async function assignTicketAccountOwnerAction(input: {
  ticketId: string;
  ownerContactId: string;
  reasonCode: string;
  reasonText?: string | null;
}) {
  const access = await assertCanManageTicketAccountOwner();
  if (!access.ok) return { success: false as const, message: access.message };
  if (!z.string().uuid().safeParse(input.ticketId).success || !z.string().uuid().safeParse(input.ownerContactId).success) {
    return { success: false as const, message: "Ingresso ou Pessoa inválida." };
  }
  let reason: ReturnType<typeof validateTicketAccountOwnerReason>;
  try {
    reason = validateTicketAccountOwnerReason(input.reasonCode, input.reasonText);
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : "Motivo inválido." };
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("admin_assign_ticket_account_owner", {
    p_ticket_id: input.ticketId,
    p_owner_contact_id: input.ownerContactId,
    p_reason_code: reason.reasonCode,
    p_reason_text: reason.reasonText,
  });
  if (error) {
    const message = error.message.includes("OWNER_HOLDER_MUTATION_FORBIDDEN")
      ? "A conta proprietária não pode alterar o titular."
      : error.message.includes("OWNER_BUYER_MUTATION_FORBIDDEN")
        ? "A conta proprietária não pode alterar o comprador."
        : `Não foi possível alterar a conta proprietária: ${error.message}`;
    return { success: false as const, message };
  }
  revalidatePath(`/ingressos/${input.ticketId}`);
  revalidatePath(`/ingressos/${input.ticketId}/editar`);
  revalidatePath("/cadastros");
  revalidatePath("/minha-conta/ingressos");
  const result = (data ?? {}) as { changed?: boolean; materialized?: boolean };
  return {
    success: true as const,
    message: result.changed === false
      ? "Nenhuma alteração necessária."
      : result.materialized
        ? "Conta proprietária atualizada. O titular do ingresso não foi alterado."
        : "Intenção de propriedade registrada. A conta ainda não está ativada; o titular não foi alterado.",
    result,
  };
}
