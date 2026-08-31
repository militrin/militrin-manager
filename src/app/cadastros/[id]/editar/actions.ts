"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function updateCadastroAction(id: string, formData: FormData) {
  await assertPermission("participants.edit_basic");
  const supabase = await createServerSupabaseClient();
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) redirect("/acesso-negado");

  const values = {
    full_name: String(formData.get("full_name") ?? "").trim(),
    cpf: String(formData.get("cpf") ?? "").replace(/\D/g, "") || null,
    birth_date: String(formData.get("birth_date") ?? "") || null,
    gender: String(formData.get("gender") ?? "").trim() || null,
    phone: String(formData.get("phone") ?? "").trim() || null,
    email: String(formData.get("email") ?? "").trim().toLowerCase() || null,
    city: String(formData.get("city") ?? "").trim() || null,
  };
  if (!values.full_name) redirect(`/cadastros/${id}/editar?erro=Nome%20obrigatório`);
  if (!values.cpf || !values.birth_date || !values.phone || !values.email) {
    redirect(`/cadastros/${id}/editar?erro=${encodeURIComponent("CPF, nascimento, telefone e e-mail são obrigatórios neste cadastro.")}`);
  }

  // Escrita SOMENTE via RPC SECURITY DEFINER: registration_contacts tem RLS
  // habilitado mas so possui policy de SELECT (registration_contacts_org_select)
  // -- um .update() direto na tabela e descartado silenciosamente pelo RLS
  // (0 linhas afetadas, sem erro), que era a causa do "salva com sucesso mas
  // nao persiste". A RPC confirma via GET DIAGNOSTICS que a linha foi mesmo
  // afetada antes de retornar sucesso.
  const { error } = await supabase.rpc("update_registration_contact_basic_info", {
    p_contact_id: id,
    p_full_name: values.full_name,
    p_cpf: values.cpf,
    p_birth_date: values.birth_date,
    p_gender: values.gender,
    p_phone: values.phone,
    p_email: values.email,
    p_city: values.city,
  });
  if (error) redirect(`/cadastros/${id}/editar?erro=${encodeURIComponent(error.message)}`);

  revalidatePath("/cadastros");
  revalidatePath(`/cadastros/${id}`);
  redirect(`/cadastros/${id}/editar?sucesso=1`);
}

export async function deleteCadastroAction(input: { contactId: string; confirmation: string; reason: string }) {
  const context = await getCurrentOrganizationContext();
  if (!context.organization?.id || !context.isOrgOwner) {
    return { success: false as const, message: "Somente o Owner da organizacao pode excluir cadastros." };
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("owner_delete_empty_registration_contact", {
    p_registration_contact_id: input.contactId,
    p_confirmation: input.confirmation,
    p_reason: input.reason,
  });
  if (error) return { success: false as const, message: error.message };
  const result = data as { success?: boolean } | null;
  if (!result?.success) return { success: false as const, message: "O cadastro nao foi excluido." };
  revalidatePath("/cadastros");
  revalidatePath(`/cadastros/${input.contactId}`);
  return { success: true as const, message: "Cadastro excluido." };
}
