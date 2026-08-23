"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const categorySchema = z.object({
  id: z.string().uuid().optional(),
  event_id: z.string().uuid(),
  name: z.string().trim().min(1, "Informe o nome da categoria."),
  slug: z.string().trim().min(1, "Informe o slug."),
  description: z.string().optional().nullable(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
});

const benefitSchema = z.object({
  ticket_category_id: z.string().uuid(),
  name: z.string().trim().min(1, "Informe o benefício."),
  description: z.string().optional().nullable(),
  sort_order: z.number().int().default(0),
});

function translateCategoryError(rawMessage: string) {
  if (rawMessage.includes("ux_ticket_categories_event_name")) {
    return "Já existe uma categoria com esse nome neste evento. Escolha outro nome.";
  }
  if (rawMessage.includes("ux_ticket_categories_event_slug")) {
    return "Já existe uma categoria com esse slug neste evento. Ajuste o slug.";
  }
  if (rawMessage.includes("ticket_categories_slug_format")) {
    return "Slug inválido: use apenas letras minúsculas, números e hífens.";
  }
  return rawMessage;
}

export async function createCategoryAction(payload: z.infer<typeof categorySchema>) {
  const parsed = categorySchema.safeParse(payload);
  if (!parsed.success) return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("create_ticket_category", {
      p_event_id: parsed.data.event_id,
      p_name: parsed.data.name,
      p_slug: parsed.data.slug,
      p_description: parsed.data.description ?? null,
      p_capacity: null,
      p_is_active: parsed.data.is_active,
      p_sort_order: parsed.data.sort_order,
    });

    if (error) throw error;

    revalidatePath("/categorias");
    revalidatePath("/inscricoes/nova");
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);
    return { success: true, message: "Categoria criada com sucesso." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? translateCategoryError(error.message) : "Falha ao criar categoria: erro desconhecido." };
  }
}

export async function updateCategoryAction(payload: z.infer<typeof categorySchema>) {
  const parsed = categorySchema.safeParse(payload);
  if (!parsed.success || !parsed.data.id) return { success: false, message: "Dados inválidos para atualização." };

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("update_ticket_category", {
      p_category_id: parsed.data.id,
      p_event_id: parsed.data.event_id,
      p_name: parsed.data.name,
      p_slug: parsed.data.slug,
      p_description: parsed.data.description ?? null,
      p_capacity: null,
      p_is_active: parsed.data.is_active,
      p_sort_order: parsed.data.sort_order,
    });

    if (error) throw error;

    revalidatePath("/categorias");
    revalidatePath("/inscricoes/nova");
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);
    return { success: true, message: "Categoria atualizada com sucesso." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? translateCategoryError(error.message) : "Falha ao atualizar categoria: erro desconhecido." };
  }
}

export async function toggleCategoryActiveAction(payload: { id: string; event_id: string; is_active: boolean }) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("set_ticket_category_active", {
      p_category_id: payload.id,
      p_event_id: payload.event_id,
      p_is_active: payload.is_active,
    });

    if (error) throw error;

    revalidatePath("/categorias");
    revalidatePath("/inscricoes/nova");
    revalidatePath(`/painel/eventos/${payload.event_id}`);
    return { success: true, message: payload.is_active ? "Categoria ativada." : "Categoria desativada." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? translateCategoryError(error.message) : "Falha ao alterar status." };
  }
}

export async function createBenefitAction(payload: z.infer<typeof benefitSchema>) {
  const parsed = benefitSchema.safeParse(payload);
  if (!parsed.success) return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("create_ticket_category_benefit", {
      p_ticket_category_id: parsed.data.ticket_category_id,
      p_name: parsed.data.name,
      p_description: parsed.data.description ?? null,
      p_sort_order: parsed.data.sort_order,
    });

    if (error) throw error;

    revalidatePath("/categorias");
    return { success: true, message: "Benefício adicionado." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao adicionar benefício." };
  }
}

export async function deleteBenefitAction(payload: { id: string }) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("delete_ticket_category_benefit", {
      p_benefit_id: payload.id,
    });

    if (error) throw error;

    revalidatePath("/categorias");
    return { success: true, message: "Benefício removido." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao remover benefício." };
  }
}
