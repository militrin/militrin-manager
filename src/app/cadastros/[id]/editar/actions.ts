"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";

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
  const { data, error } = await supabase.rpc("prepare_owner_registration_contact_deletion", {
    p_registration_contact_id: input.contactId,
    p_confirmation: input.confirmation,
    p_reason: input.reason,
  });
  if (error) return { success: false as const, message: error.message };
  const prepared = data as {
    success?: boolean;
    blocked?: boolean;
    blockers?: Record<string, number>;
    message?: string;
    request_id?: string;
    auth_user_id?: string | null;
  } | null;
  if (!prepared?.success || !prepared.request_id) {
    const labels: Record<string, [string, string]> = {
      pedidos: ["pedido", "pedidos"], ingressos: ["ingresso", "ingressos"], pagamentos: ["pagamento", "pagamentos"],
      participacoes_historicas: ["participacao historica", "participacoes historicas"], pedidos_loja: ["pedido da loja", "pedidos da loja"],
      lancamentos_financeiros: ["lancamento financeiro", "lancamentos financeiros"], cupons: ["uso de cupom", "usos de cupom"],
      entregas: ["entrega/check-in", "entregas/check-ins"], itens_operacionais: ["item operacional", "itens operacionais"],
      pulseiras: ["pulseira", "pulseiras"], historico_titularidade: ["registro de titularidade", "registros de titularidade"],
      patrocinios: ["patrocinio", "patrocinios"], convites_administrados: ["convite administrativo", "convites administrativos"],
    };
    const details = Object.entries(prepared?.blockers ?? {}).filter(([, count]) => count > 0)
      .map(([key, count]) => `${count} ${labels[key]?.[count === 1 ? 0 : 1] ?? key}`);
    const message = details.length > 0
      ? `Exclusao bloqueada porque este cadastro possui ${details.join(", ")}. O historico foi preservado.`
      : prepared?.message ?? "O cadastro nao pode ser excluido.";
    return { success: false as const, message };
  }

  if (prepared.auth_user_id) {
    // Auth e Postgres nao compartilham transacao. Removemos primeiro o Auth:
    // se isso falhar, nenhum dado de negocio foi apagado; se a finalizacao
    // falhar, a solicitacao duravel permite repetir a limpeza com seguranca.
    const admin = createServiceRoleSupabaseClient();
    const { error: authError } = await admin.auth.admin.deleteUser(prepared.auth_user_id);
    const authAlreadyAbsent = authError?.status === 404 || authError?.code === "user_not_found";
    if (authError && !authAlreadyAbsent) {
      console.error("Failed to delete registration contact Auth user", {
        requestId: prepared.request_id,
        authUserId: prepared.auth_user_id,
        code: authError.code,
        status: authError.status,
      });
      return { success: false as const, message: "Nao foi possivel excluir a conta de acesso. Nenhum cadastro foi removido; tente novamente." };
    }
    const { error: markError } = await supabase.rpc("mark_owner_registration_contact_auth_deleted", {
      p_request_id: prepared.request_id,
    });
    if (markError) {
      console.error("Failed to mark Auth deletion", { requestId: prepared.request_id, code: markError.code });
      return { success: false as const, message: "A conta de acesso foi removida, mas a limpeza do cadastro ficou pendente. Repita a exclusao para concluir." };
    }
  }

  const { data: finalizedData, error: finalizeError } = await supabase.rpc("finalize_owner_registration_contact_deletion", {
    p_request_id: prepared.request_id,
  });
  if (finalizeError) {
    console.error("Failed to finalize registration contact deletion", { requestId: prepared.request_id, code: finalizeError.code });
    return { success: false as const, message: "Nao foi possivel concluir a limpeza do cadastro. Tente novamente; a operacao e segura para repeticao." };
  }
  const finalized = finalizedData as { success?: boolean } | null;
  if (!finalized?.success) return { success: false as const, message: "O cadastro nao foi excluido." };
  revalidatePath("/cadastros");
  revalidatePath(`/cadastros/${input.contactId}`);
  return { success: true as const, message: prepared.auth_user_id ? "Cadastro e conta excluidos." : "Cadastro excluido." };
}
