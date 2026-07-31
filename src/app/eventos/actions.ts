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

const kitDeliveryScheduleSchema = z.object({
  id: z.string().uuid().optional(),
  delivery_at: z.string().trim().min(1, 'Informe dia e hora da entrega.'),
  city: z.string().trim().min(1, 'Informe a cidade.'),
  location: z.string().trim().min(1, 'Informe o local.'),
  sort_order: z.number().int().default(0),
  is_active: z.boolean().default(true),
});

const eventPaymentMethodsSchema = z.object({
  event_id: z.string().uuid(),
  pix_enabled: z.boolean().default(true),
  credit_card_single_enabled: z.boolean().default(true),
  credit_card_installments_enabled: z.boolean().default(true),
});

function parseTs(value?: string | null) {
  if (!value?.trim()) return null;
  return new Date(value).toISOString();
}

function resolveActionErrorMessage(error: unknown, fallback: string) {
  const normalized = JSON.stringify(error ?? {}).toLowerCase();
  if (normalized.includes('shirt_inventory_unique') || normalized.includes('ux_shirt_inventory_type_size')) {
    return 'Não foi possível criar o evento porque o banco ainda está com uma regra antiga de estoque global. Aplique a migration 051 e tente novamente.';
  }

  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { message?: unknown; details?: unknown; hint?: unknown };
    const message = typeof maybe.message === 'string' ? maybe.message : '';
    const details = typeof maybe.details === 'string' ? maybe.details : '';
    const hint = typeof maybe.hint === 'string' ? maybe.hint : '';
    const merged = [message, details, hint].filter(Boolean).join(' | ').trim();
    if (merged) return merged;
  }
  return fallback;
}

async function revalidateEventsPages() {
  revalidatePath('/eventos');
  revalidatePath('/painel/eventos');
  revalidatePath("/inscricoes/nova");
  revalidatePath("/retirada");
  revalidatePath("/");
  revalidatePath('/minha-conta');
}

export async function setEventHighlightAction(payload: { event_id: string; sort_order: number; is_active?: boolean }) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('upsert_event_highlight', {
      p_event_id: payload.event_id,
      p_sort_order: Number(payload.sort_order ?? 0),
      p_is_active: payload.is_active ?? true,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: 'Evento destacado salvo.' };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Falha ao salvar destaque do evento.' };
  }
}

export async function removeEventHighlightAction(eventId: string) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('remove_event_highlight', {
      p_event_id: eventId,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: 'Evento removido dos destaques.' };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Falha ao remover destaque do evento.' };
  }
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

    const { data: createdEvent, error: fetchCreatedError } = await supabase
      .from('events')
      .select('id')
      .eq('slug', parsed.data.slug)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchCreatedError) throw fetchCreatedError;

    await revalidateEventsPages();
    return {
      success: true,
      message: "Evento criado com sucesso.",
      eventId: createdEvent?.id ? String(createdEvent.id) : null,
    };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, "Falha ao criar evento.") };
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
    return { success: false, message: resolveActionErrorMessage(error, "Falha ao atualizar evento.") };
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

export async function deactivateEventAction(eventId: string) {
  try {
    const supabase = await createServerSupabaseClient();

    const { data: currentEvent, error: eventError } = await supabase
      .from('events')
      .select('id, name, slug, year, description, starts_at, ends_at, registration_open_at, registration_close_at, location, registration_enabled, kit_enabled')
      .eq('id', eventId)
      .maybeSingle();

    if (eventError) throw eventError;
    if (!currentEvent?.id) {
      return { success: false, message: 'Evento não encontrado.' };
    }

    const { error } = await supabase.rpc('update_event', {
      p_event_id: String(currentEvent.id),
      p_name: String(currentEvent.name ?? ''),
      p_slug: String(currentEvent.slug ?? ''),
      p_year: currentEvent.year === null || currentEvent.year === undefined ? null : Number(currentEvent.year),
      p_description: currentEvent.description ? String(currentEvent.description) : null,
      p_starts_at: currentEvent.starts_at ? String(currentEvent.starts_at) : null,
      p_ends_at: currentEvent.ends_at ? String(currentEvent.ends_at) : null,
      p_registration_open_at: currentEvent.registration_open_at ? String(currentEvent.registration_open_at) : null,
      p_registration_close_at: currentEvent.registration_close_at ? String(currentEvent.registration_close_at) : null,
      p_location: currentEvent.location ? String(currentEvent.location) : null,
      p_is_active: false,
      p_registration_enabled: Boolean(currentEvent.registration_enabled),
      p_kit_enabled: Boolean(currentEvent.kit_enabled),
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: 'Evento desativado.' };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, 'Falha ao desativar evento.') };
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
    return { success: true, message: enabled ? "Vendas abertas." : "Vendas fechadas." };
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

export async function upsertKitDeliveryScheduleAction(payload: z.infer<typeof kitDeliveryScheduleSchema>) {
  const parsed = kitDeliveryScheduleSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? 'Dados inválidos para entrega de kits.' };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('upsert_kit_delivery_schedule', {
      p_id: parsed.data.id ?? null,
      p_delivery_at: parseTs(parsed.data.delivery_at),
      p_city: parsed.data.city,
      p_location: parsed.data.location,
      p_sort_order: Number(parsed.data.sort_order ?? 0),
      p_is_active: parsed.data.is_active,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: parsed.data.id ? 'Entrega de kits atualizada.' : 'Entrega de kits criada.' };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Falha ao salvar entrega de kits.' };
  }
}

export async function deleteKitDeliveryScheduleAction(id: string) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('delete_kit_delivery_schedule', {
      p_id: id,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: 'Entrega de kits removida.' };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Falha ao remover entrega de kits.' };
  }
}

export async function upsertEventPaymentMethodsAction(payload: z.infer<typeof eventPaymentMethodsSchema>) {
  const parsed = eventPaymentMethodsSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? 'Dados invalidos para formas de pagamento.' };
  }

  if (!parsed.data.pix_enabled && !parsed.data.credit_card_single_enabled && !parsed.data.credit_card_installments_enabled) {
    return { success: false, message: 'Selecione pelo menos uma forma de pagamento.' };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('upsert_event_payment_methods', {
      p_event_id: parsed.data.event_id,
      p_pix_enabled: parsed.data.pix_enabled,
      p_credit_card_single_enabled: parsed.data.credit_card_single_enabled,
      p_credit_card_installments_enabled: parsed.data.credit_card_installments_enabled,
    });

    if (error) throw error;
    await revalidateEventsPages();
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);
    revalidatePath(`/inscricao`);
    return { success: true, message: 'Formas de pagamento salvas.' };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, 'Falha ao salvar formas de pagamento.') };
  }
}

export async function upsertEventAddonsConfigAction(payload: {
  event_id: string;
  apply_to_all_batches: boolean;
  kit_enabled: boolean;
  custom_cup_enabled: boolean;
  gifts_enabled: boolean;
}) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('upsert_event_addons_config', {
      p_event_id: payload.event_id,
      p_apply_to_all_batches: payload.apply_to_all_batches,
      p_kit_enabled: payload.kit_enabled,
      p_custom_cup_enabled: payload.custom_cup_enabled,
      p_gifts_enabled: payload.gifts_enabled,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: 'Configuração de adicionais salva.' };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Falha ao salvar adicionais.' };
  }
}

export async function upsertBatchAddonsConfigAction(payload: {
  event_id: string;
  batch_id: string;
  kit_enabled: boolean;
  custom_cup_enabled: boolean;
  gifts_enabled: boolean;
}) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('upsert_registration_batch_addons', {
      p_event_id: payload.event_id,
      p_batch_id: payload.batch_id,
      p_kit_enabled: payload.kit_enabled,
      p_custom_cup_enabled: payload.custom_cup_enabled,
      p_gifts_enabled: payload.gifts_enabled,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: 'Adicionais do lote salvos.' };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Falha ao salvar adicionais do lote.' };
  }
}

export async function upsertEventAddonsModelAction(payload: {
  event_id: string;
  apply_to_all_batches: boolean;
}) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('upsert_event_addons_model', {
      p_event_id: payload.event_id,
      p_apply_to_all_batches: payload.apply_to_all_batches,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: 'Modelo de adicionais salvo.' };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, 'Falha ao salvar modelo de adicionais.') };
  }
}

export async function upsertEventAddonOptionAction(payload: {
  event_id: string;
  name: string;
  description?: string | null;
  sort_order?: number;
  is_active?: boolean;
  id?: string;
}) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('upsert_event_addon_option', {
      p_event_id: payload.event_id,
      p_name: payload.name,
      p_description: payload.description ?? null,
      p_sort_order: Number(payload.sort_order ?? 0),
      p_is_active: payload.is_active ?? true,
      p_id: payload.id ?? null,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: payload.id ? 'Adicional atualizado.' : 'Adicional criado.' };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, 'Falha ao salvar adicional.') };
  }
}

export async function deleteEventAddonOptionAction(payload: { event_id: string; option_id: string }) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('delete_event_addon_option', {
      p_event_id: payload.event_id,
      p_option_id: payload.option_id,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: 'Adicional removido.' };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, 'Falha ao remover adicional.') };
  }
}

export async function upsertBatchAddonOptionAction(payload: {
  event_id: string;
  batch_id: string;
  option_id: string;
  enabled: boolean;
}) {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('upsert_event_batch_addon_option', {
      p_event_id: payload.event_id,
      p_batch_id: payload.batch_id,
      p_option_id: payload.option_id,
      p_enabled: payload.enabled,
    });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: 'Configuração do lote salva.' };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, 'Falha ao salvar configuração do lote.') };
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
    revalidatePath('/eventos');
    revalidatePath('/painel/eventos');
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);
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
    revalidatePath('/eventos');
    revalidatePath('/painel/eventos');
    revalidatePath(`/painel/eventos/${payload.event_id}`);
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
    revalidatePath('/eventos');
    revalidatePath('/painel/eventos');
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
    revalidatePath('/eventos');
    revalidatePath('/painel/eventos');
    revalidatePath("/inscricoes/nova");
    return { success: true, message: "Variação removida." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao remover variação." };
  }
}
