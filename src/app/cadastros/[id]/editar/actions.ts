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
    updated_at: new Date().toISOString(),
  };
  if (!values.full_name) redirect(`/cadastros/${id}/editar?erro=Nome%20obrigatório`);
  if (!values.cpf || !values.birth_date || !values.phone || !values.email) {
    redirect(`/cadastros/${id}/editar?erro=${encodeURIComponent("CPF, nascimento, telefone e e-mail são obrigatórios neste cadastro.")}`);
  }

  const { error } = await supabase.from("registration_contacts")
    .update({ ...values, cpf: values.cpf, birth_date: values.birth_date, phone: values.phone, email: values.email })
    .eq("id", id)
    .eq("organization_id", organization.id);
  if (error) redirect(`/cadastros/${id}/editar?erro=${encodeURIComponent(error.message)}`);

  revalidatePath("/cadastros");
  revalidatePath(`/cadastros/${id}`);
  redirect(`/cadastros/${id}/editar?sucesso=1`);
}
