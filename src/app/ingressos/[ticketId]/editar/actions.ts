"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/admin/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { buildAdminSetTicketHolderPayload } from "@/lib/admin/ticket-holder-rpc";
import { buildAdminTransferTicketOwnershipPayload, type TicketOwnerHolderAction } from "@/lib/admin/ticket-owner-rpc";

export async function searchTicketHolderCandidatesAction(ticketId: string, term: string) {
  await assertPermission("participants.edit_basic");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("search_admin_ticket_holder_contacts", { p_ticket_id: ticketId, p_term: term });
  if (error) return { success: false as const, message: error.message, candidates: [] };
  return { success: true as const, message: data?.length ? `${data.length} cadastro(s) encontrado(s).` : "Nenhum cadastro encontrado.", candidates: data ?? [] };
}

export async function searchTicketOwnerAccountsAction(ticketId: string, term: string) {
  await assertPermission("tickets.transfer_ownership");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("search_admin_ticket_owner_accounts", { p_ticket_id: ticketId, p_term: term });
  if (error) return { success: false as const, message: error.message, candidates: [] };
  return { success: true as const, message: data?.length ? `${data.length} conta(s) encontrada(s).` : "Nenhuma conta NEXORA encontrada.", candidates: data ?? [] };
}

export async function transferTicketOwnershipAction(input: {
  ticketId: string; expectedOwnerUserId: string | null; newOwnerUserId: string;
  holderAction: TicketOwnerHolderAction; reasonCode: string; reasonText?: string | null;
}) {
  await assertPermission("tickets.transfer_ownership");
  let payload: ReturnType<typeof buildAdminTransferTicketOwnershipPayload>;
  try { payload = buildAdminTransferTicketOwnershipPayload(input); }
  catch (error) { return { success:false as const,message:error instanceof Error?error.message:"Dados de propriedade inválidos." }; }
  const supabase=await createServerSupabaseClient();
  const {data,error}=await supabase.rpc("admin_transfer_ticket_ownership",payload);
  if(error){
    const message=error.message.includes("TICKET_OWNER_CHANGED_CONCURRENTLY")?"A propriedade foi alterada por outro administrador. Atualize a tela e tente novamente."
      :error.message.includes("OWNER_CONTACT_AMBIGUOUS")?"A conta possui mais de um cadastro vinculado. Mantenha o titular atual ou deixe o ingresso sem titular."
      :error.message.includes("HOLDER_ALREADY_HAS_TICKET_FOR_EVENT")?"O novo proprietário já é titular de outro ingresso ativo neste evento."
      :`Não foi possível transferir a propriedade: ${error.message}`;
    return {success:false as const,message};
  }
  revalidatePath("/minha-conta/ingressos"); revalidatePath(`/ingressos/${input.ticketId}`); revalidatePath(`/ingressos/${input.ticketId}/editar`);
  return {success:true as const,message:"Propriedade transferida com sucesso.",result:data};
}

export async function transferTicketHolderAction(ticketId: string, registrationContactId: string | null | undefined, reasonCode: string, reasonText?: string | null) {
  await assertPermission("participants.edit_basic");
  let payload: ReturnType<typeof buildAdminSetTicketHolderPayload>;
  try {
    payload = buildAdminSetTicketHolderPayload(ticketId, registrationContactId, reasonCode, reasonText);
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : "Dados de titularidade inválidos." };
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("admin_set_ticket_holder_contact", payload);
  if (error) return { success: false as const, message: error.message.includes("HOLDER_ALREADY_HAS_TICKET_FOR_EVENT") ? "Esta pessoa já é titular de outro ingresso neste evento." : `Não foi possível alterar o titular: ${error.message}` };
  revalidatePath(`/ingressos/${ticketId}`); revalidatePath(`/ingressos/${ticketId}/editar`);
  return { success: true as const, message: (data as { changed?: boolean })?.changed === false ? "Nenhuma alteração necessária." : payload.p_registration_contact_id ? "Titularidade atualizada." : "Titular removido com sucesso." };
}

export async function cancelTicketAction(ticketId: string, reason: string, confirmed: boolean, replacementRequired: boolean) {
  await assertPermission("orders.cancel");
  if (!confirmed) return { success: false as const, message: "Confirmação explícita obrigatória." };
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("admin_cancel_ticket", { p_ticket_id: ticketId, p_reason: reason, p_replacement_required: replacementRequired });
  if (error) return { success: false as const, message: error.message };
  revalidatePath(`/ingressos/${ticketId}`); revalidatePath(`/ingressos/${ticketId}/editar`);
  const result = data as { changed?: boolean; reclassified?: boolean } | null;
  return { success: true as const, message: result?.changed === false ? "Nenhuma alteração: essa já era a decisão registrada." : result?.reclassified ? "Decisão sobre este ingresso atualizada." : "Ingresso cancelado." };
}
