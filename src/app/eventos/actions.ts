"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const eventSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Informe o nome do evento."),
  slug: z.string().trim().min(1, "Informe o slug."),
  year: z.union([z.number().int(), z.null()]),
  description: z.string().optional().nullable(),
  starts_at: z.string().optional().nullable(),
  ends_at: z.string().optional().nullable(),
  registration_open_at: z.string().optional().nullable(),
  registration_close_at: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  is_active: z.boolean().default(false),
  registration_enabled: z.boolean().default(false),
  kit_enabled: z.boolean().default(false),
});

const duplicateSchema = z.object({
  source_event_id: z.string().uuid(),
  target_name: z.string().trim().min(1),
  target_slug: z.string().trim().min(1),
  target_year: z.union([z.number().int(), z.null()]),
  copy_categories: z.boolean().default(true),
  copy_kit_items: z.boolean().default(true),
  copy_benefits: z.boolean().default(true),
  copy_batches: z.boolean().default(true),
  copy_batch_prices: z.boolean().default(true),
  copy_inventory_structure: z.boolean().default(true),
  copy_coupons: z.boolean().default(false),
});

function parseTs(value?: string | null) {
  if (!value?.trim()) return null;
  return new Date(value).toISOString();
}

async function revalidateEventsPages() {
  revalidatePath("/eventos");
  revalidatePath("/inscricoes/nova");
  revalidatePath("/retirada");
  revalidatePath("/");
}

export async function createEventAction(payload: z.infer<typeof eventSchema>) {
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("create_event", {
      p_name: parsed.data.name,
      p_slug: parsed.data.slug,
      p_year: parsed.data.year,
      p_description: parsed.data.description ?? null,
      p_starts_at: parseTs(parsed.data.starts_at),
      p_ends_at: parseTs(parsed.data.ends_at),
      p_registration_open_at: parseTs(parsed.data.registration_open_at),
      p_registration_close_at: parseTs(parsed.data.registration_close_at),
      p_location: parsed.data.location ?? null,
      p_is_active: parsed.data.is_active,
      p_registration_enabled: parsed.data.registration_enabled,
      p_kit_enabled: parsed.data.kit_enabled,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: "Evento criado com sucesso." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao criar evento." };
  }
}

export async function updateEventAction(payload: z.infer<typeof eventSchema>) {
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.id) {
    return { success: false, message: "Dados inválidos para atualizar evento." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("update_event", {
      p_event_id: parsed.data.id,
      p_name: parsed.data.name,
      p_slug: parsed.data.slug,
      p_year: parsed.data.year,
      p_description: parsed.data.description ?? null,
      p_starts_at: parseTs(parsed.data.starts_at),
      p_ends_at: parseTs(parsed.data.ends_at),
      p_registration_open_at: parseTs(parsed.data.registration_open_at),
      p_registration_close_at: parseTs(parsed.data.registration_close_at),
      p_location: parsed.data.location ?? null,
      p_is_active: parsed.data.is_active,
      p_registration_enabled: parsed.data.registration_enabled,
      p_kit_enabled: parsed.data.kit_enabled,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: "Evento atualizado com sucesso." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao atualizar evento." };
  }
}

export async function activateEventAction(eventId: string) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("set_event_active", { p_event_id: eventId });
    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: "Evento ativado." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao ativar evento." };
  }
}

export async function setEventRegistrationEnabledAction(eventId: string, enabled: boolean) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("set_event_registration_enabled", {
      p_event_id: eventId,
      p_enabled: enabled,
    });
    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: enabled ? "Inscrições abertas." : "Inscrições fechadas." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao alterar inscrições." };
  }
}

export async function archiveEventAction(eventId: string) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("archive_event", { p_event_id: eventId });
    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: "Evento arquivado." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao arquivar evento." };
  }
}

export async function duplicateEventAction(payload: z.infer<typeof duplicateSchema>) {
  const parsed = duplicateSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos para duplicação." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("duplicate_event_configuration", {
      p_source_event_id: parsed.data.source_event_id,
      p_target_name: parsed.data.target_name,
      p_target_slug: parsed.data.target_slug,
      p_target_year: parsed.data.target_year,
      p_copy_categories: parsed.data.copy_categories,
      p_copy_kit_items: parsed.data.copy_kit_items,
      p_copy_benefits: parsed.data.copy_benefits,
      p_copy_batches: parsed.data.copy_batches,
      p_copy_batch_prices: parsed.data.copy_batch_prices,
      p_copy_inventory_structure: parsed.data.copy_inventory_structure,
      p_copy_coupons: parsed.data.copy_coupons,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: "Configuração de evento duplicada com sucesso." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao duplicar evento." };
  }
}

const kitItemSchema = z.object({
  id: z.string().uuid().optional(),
  event_id: z.string().uuid(),
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  description: z.string().optional().nullable(),
  item_type: z.enum(["shirt", "cup", "strap", "cup_holder", "wristband", "badge", "voucher", "other"]),
  quantity_per_participant: z.number().int().positive(),
  requires_variant: z.boolean().default(false),
  is_required: z.boolean().default(true),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().default(0),
});

const kitVariantSchema = z.object({
  id: z.string().uuid().optional(),
  kit_item_id: z.string().uuid(),
  name: z.string().trim().min(1),
  value: z.string().trim().min(1),
  sort_order: z.number().int().default(0),
  is_active: z.boolean().default(true),
});

export async function upsertKitItemAction(payload: z.infer<typeof kitItemSchema>) {
  const parsed = kitItemSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos do item." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("upsert_event_kit_item", {
      p_id: parsed.data.id ?? null,
      p_event_id: parsed.data.event_id,
      p_name: parsed.data.name,
      p_slug: parsed.data.slug,
      p_description: parsed.data.description ?? null,
      p_item_type: parsed.data.item_type,
      p_quantity_per_participant: parsed.data.quantity_per_participant,
      p_requires_variant: parsed.data.requires_variant,
      p_is_required: parsed.data.is_required,
      p_is_active: parsed.data.is_active,
      p_sort_order: parsed.data.sort_order,
    });
    if (error) throw error;
    revalidatePath(`/eventos/${parsed.data.event_id}`);
    revalidatePath("/inscricoes/nova");
    return { success: true, message: "Item do kit salvo com sucesso." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao salvar item do kit." };
  }
}

export async function deleteKitItemAction(payload: { event_id: string; kit_item_id: string }) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("delete_event_kit_item", {
      p_event_id: payload.event_id,
      p_kit_item_id: payload.kit_item_id,
    });
    if (error) throw error;
    revalidatePath(`/eventos/${payload.event_id}`);
    revalidatePath("/inscricoes/nova");
    return { success: true, message: "Item removido." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao remover item." };
  }
}

export async function upsertKitVariantAction(payload: z.infer<typeof kitVariantSchema>) {
  const parsed = kitVariantSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos da variação." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("upsert_event_kit_item_variant", {
      p_id: parsed.data.id ?? null,
      p_kit_item_id: parsed.data.kit_item_id,
      p_name: parsed.data.name,
      p_value: parsed.data.value,
      p_sort_order: parsed.data.sort_order,
      p_is_active: parsed.data.is_active,
    });
    if (error) throw error;
    revalidatePath("/eventos");
    revalidatePath("/inscricoes/nova");
    return { success: true, message: "Variação salva." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao salvar variação." };
  }
}

export async function deleteKitVariantAction(variantId: string) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("delete_event_kit_item_variant", { p_variant_id: variantId });
    if (error) throw error;
    revalidatePath("/eventos");
    revalidatePath("/inscricoes/nova");
    return { success: true, message: "Variação removida." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao remover variação." };
  }
}
