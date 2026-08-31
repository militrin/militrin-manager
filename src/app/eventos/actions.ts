"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";

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
  min_age: z.number().int().min(0, "Idade mínima inválida.").default(18),
  banner_hero_url: z.string().optional().nullable(),
  banner_card_url: z.string().optional().nullable(),
});

export async function setEventParticipantItemChangesAction(eventId: string, enabled: boolean) {
  await assertPermission("events.edit");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_event_participant_item_changes", {
    p_event_id: eventId,
    p_enabled: enabled,
  });
  if (error) return { success: false, message: error.message };
  revalidatePath(`/painel/eventos/${eventId}`);
  return { success: true, message: "Configuração salva." };
}

export async function updateEventWristbandSettingsAction(payload: {
  eventId: string;
  enabled: boolean;
  requiredForCheckin: boolean;
  requiredForKit: boolean;
}) {
  await assertPermission("events.edit");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_event_wristband_settings", {
    p_event_id: payload.eventId,
    p_enabled: payload.enabled,
    p_required_for_checkin: payload.requiredForCheckin,
    p_required_for_kit: payload.requiredForKit,
  });
  if (error) return { success: false as const, message: error.message };
  revalidatePath(`/painel/eventos/${payload.eventId}`);
  return { success: true as const, message: "Configuração de pulseiras salva." };
}

export async function setEventKitItemChangeRulesAction(
  itemId: string,
  allowChange: boolean,
  trackInventory: boolean,
  requireStockForChoice?: boolean,
) {
  await assertPermission("events.edit");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_event_kit_item_change_rules", {
    p_kit_item_id: itemId,
    p_allow_change: allowChange,
    p_track_inventory: trackInventory,
    p_require_stock_for_choice: requireStockForChoice ?? null,
  });
  if (error) return { success: false, message: error.message };
  const { data: saved, error: readError } = await supabase.from("event_kit_items")
    .select("id,event_id,allow_participant_change,track_variant_inventory,shirt_supply_mode")
    .eq("id", itemId).maybeSingle();
  if (readError || !saved) return { success: false, message: readError?.message ?? "Não foi possível reler a regra salva." };
  revalidatePath(`/painel/eventos/${saved.event_id}`);
  return {
    success: true,
    message: "Regra do item salva.",
    saved: {
      allowParticipantChange: Boolean(saved.allow_participant_change),
      trackVariantInventory: Boolean(saved.track_variant_inventory),
      requireStockForChoice: saved.shirt_supply_mode === "stock",
    },
  };
}

export async function setEventKitItemVariantStockAction(variantId: string, totalQuantity: number) {
  await assertPermission("inventory.adjust");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_event_kit_item_variant_stock", { p_variant_id: variantId, p_total_quantity: totalQuantity });
  if (error) return { success: false, message: error.message };
  return { success: true, message: "Estoque da opção salvo." };
}

export async function setEventTicketHolderRulesAction(eventId: string, allowHolderChange: boolean, allowTicketTransfer: boolean) {
  await assertPermission("events.edit");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_event_ticket_holder_rules", { p_event_id: eventId, p_allow_holder_change: allowHolderChange, p_allow_ticket_transfer: allowTicketTransfer });
  if (error) return { success: false, message: error.message };
  revalidatePath(`/painel/eventos/${eventId}`);
  return { success: true, message: "Regras de titularidade salvas." };
}

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

const eventScheduleSchema = z.object({
  id: z.string().uuid().optional(),
  event_id: z.string().uuid(),
  delivery_at: z.string().trim().min(1, 'Informe dia e hora do compromisso.'),
  title: z.string().trim().min(1, 'Informe o título.'),
  location: z.string().trim().optional().nullable(),
  description: z.string().trim().optional().nullable(),
  schedule_type: z.enum(['kit_pickup', 'gates_open', 'event_start', 'attraction', 'accreditation', 'meeting', 'closing', 'other']),
  sort_order: z.number().int().default(0),
  is_active: z.boolean().default(true),
  is_visible_to_users: z.boolean().default(true),
});

const paymentFeeModeSchema = z.enum(['absorb', 'pass_through', 'split']);
const feePercentSchema = z.number().min(0).max(100).default(0);
const feeFixedAmountSchema = z.number().min(0).default(0);

const installmentFeeSchema = z.object({
  installments: z.number().int().min(1),
  fixed_fee: feeFixedAmountSchema,
  percentage_fee: feePercentSchema,
});

const eventPaymentMethodsSchema = z.object({
  event_id: z.string().uuid(),
  pix_enabled: z.boolean().default(true),
  credit_card_single_enabled: z.boolean().default(true),
  credit_card_installments_enabled: z.boolean().default(true),
  pix_fee_mode: paymentFeeModeSchema.default('absorb'),
  pix_fee_fixed_amount: feeFixedAmountSchema,
  pix_fee_percentage: feePercentSchema,
  pix_customer_fee_share_percent: feePercentSchema,
  credit_card_single_fee_mode: paymentFeeModeSchema.default('absorb'),
  credit_card_single_fee_fixed_amount: feeFixedAmountSchema,
  credit_card_single_fee_percentage: feePercentSchema,
  credit_card_single_customer_fee_share_percent: feePercentSchema,
  credit_card_installments_fee_mode: paymentFeeModeSchema.default('absorb'),
  credit_card_installments_customer_fee_share_percent: feePercentSchema,
  installment_fees: z.array(installmentFeeSchema).default([]),
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
  await assertPermission("events.edit");
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
  await assertPermission("events.edit");
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
  await assertPermission("events.create");
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  try {
    const supabase = await createServerSupabaseClient();

    // Resolve organização no servidor — nunca confia no cliente
    const { data: orgId, error: orgError } = await supabase.rpc('current_organization_id');
    if (orgError) throw orgError;
    if (!orgId) {
      return { success: false, message: 'Nenhuma organização encontrada para o usuário.' };
    }

    const { data: createdEventId, error } = await supabase.rpc("create_event", {
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
      p_organization_id: orgId as string,
      p_min_age: parsed.data.min_age,
      p_banner_hero_url: parsed.data.banner_hero_url ?? null,
      p_banner_card_url: parsed.data.banner_card_url ?? null,
    });

    if (error) throw error;

    await revalidateEventsPages();
    return {
      success: true,
      message: "Evento criado com sucesso.",
      eventId: createdEventId ? String(createdEventId) : null,
    };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, "Falha ao criar evento.") };
  }
}

export async function updateEventAction(payload: z.infer<typeof eventSchema>) {
  await assertPermission("events.edit");
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
      p_banner_hero_url: parsed.data.banner_hero_url ?? null,
      p_banner_card_url: parsed.data.banner_card_url ?? null,
    });

    if (error) throw error;

    const { error: minAgeError } = await supabase.rpc("set_event_min_age", {
      p_event_id: parsed.data.id,
      p_min_age: parsed.data.min_age,
    });
    if (minAgeError) throw minAgeError;

    await revalidateEventsPages();
    return { success: true, message: "Evento atualizado com sucesso." };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, "Falha ao atualizar evento.") };
  }
}

export async function activateEventAction(eventId: string) {
  await assertPermission("events.publish");
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
  await assertPermission("events.publish");
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('set_event_inactive', { p_event_id: eventId });

    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: 'Evento desativado.' };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, 'Falha ao desativar evento.') };
  }
}

export async function setEventRegistrationEnabledAction(eventId: string, enabled: boolean) {
  await assertPermission("events.publish");
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
  await assertPermission("events.archive");
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
  await assertPermission("events.create");
  const parsed = duplicateSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos para duplicação." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { data: newEventId, error } = await supabase.rpc("duplicate_event_configuration", {
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

    if (newEventId) {
      const { data: sourceEvent } = await supabase
        .from("events")
        .select("min_age")
        .eq("id", parsed.data.source_event_id)
        .maybeSingle();
      if (sourceEvent?.min_age !== undefined && sourceEvent?.min_age !== null) {
        await supabase.rpc("set_event_min_age", { p_event_id: newEventId, p_min_age: sourceEvent.min_age });
      }
    }

    await revalidateEventsPages();
    return {
      success: true,
      message: "Configuração de evento duplicada com sucesso.",
      eventId: newEventId ? String(newEventId) : null,
    };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao duplicar evento." };
  }
}

export async function upsertEventScheduleAction(payload: z.infer<typeof eventScheduleSchema>) {
  await assertPermission("events.edit");
  const parsed = eventScheduleSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? 'Dados inválidos para o compromisso.' };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc('upsert_event_schedule_item', {
      p_id: parsed.data.id ?? null,
      p_event_id: parsed.data.event_id,
      p_delivery_at: parseTs(parsed.data.delivery_at),
      p_title: parsed.data.title,
      p_location: parsed.data.location,
      p_description: parsed.data.description,
      p_schedule_type: parsed.data.schedule_type,
      p_sort_order: Number(parsed.data.sort_order ?? 0),
      p_is_active: parsed.data.is_active,
      p_is_visible_to_users: parsed.data.is_visible_to_users,
    });

    if (error) throw error;
    await revalidateEventsPages();
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);
    revalidatePath('/minha-conta/entregas');
    return { success: true, id: String(data), message: parsed.data.id ? 'Compromisso atualizado.' : 'Compromisso criado.' };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Falha ao salvar compromisso.' };
  }
}

export async function restoreEventAction(eventId: string) {
  await assertPermission("events.archive");
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("restore_event", { p_event_id: eventId });
    if (error) throw error;
    await revalidateEventsPages();
    return { success: true, message: "Evento restaurado como inativo e com vendas fechadas." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao restaurar evento." };
  }
}

export async function deleteEventScheduleAction(id: string, eventId: string) {
  await assertPermission("events.edit");
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('delete_event_schedule_item', {
      p_id: id,
    });

    if (error) throw error;
    await revalidateEventsPages();
    revalidatePath(`/painel/eventos/${eventId}`);
    revalidatePath('/minha-conta/entregas');
    return { success: true, message: 'Compromisso removido.' };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Falha ao remover compromisso.' };
  }
}

export async function upsertEventPaymentMethodsAction(payload: z.infer<typeof eventPaymentMethodsSchema>) {
  await assertPermission("events.edit");
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
      p_pix_fee_mode: parsed.data.pix_fee_mode,
      p_pix_fee_fixed_amount: parsed.data.pix_fee_fixed_amount,
      p_pix_fee_percentage: parsed.data.pix_fee_percentage,
      p_pix_customer_fee_share_percent: parsed.data.pix_customer_fee_share_percent,
      p_credit_card_single_fee_mode: parsed.data.credit_card_single_fee_mode,
      p_credit_card_single_fee_fixed_amount: parsed.data.credit_card_single_fee_fixed_amount,
      p_credit_card_single_fee_percentage: parsed.data.credit_card_single_fee_percentage,
      p_credit_card_single_customer_fee_share_percent: parsed.data.credit_card_single_customer_fee_share_percent,
      p_credit_card_installments_fee_mode: parsed.data.credit_card_installments_fee_mode,
      p_credit_card_installments_customer_fee_share_percent: parsed.data.credit_card_installments_customer_fee_share_percent,
      p_installment_fees: parsed.data.installment_fees,
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

// Substitui o antigo fluxo de preco fixo (setEventSingleTicketPriceAction/
// getEventSingleTicketPriceStatusAction, 1 unico lote sempre sobrescrito)
// por lotes reais e independentes por genero, reaproveitando
// registration_batches/registration_batch_prices -- ver migration
// 20260865000000_single_ticket_multi_batch_gender_split.sql.
const singleTicketBatchCreateSchema = z.object({
  event_id: z.string().uuid(),
  name: z.string().trim().min(1, 'Informe o nome do lote.'),
  sequence_number: z.number().int().positive('Ordem do lote invalida.'),
  male_price: z.number().min(0, 'Preço masculino inválido.'),
  female_price: z.number().min(0, 'Preço feminino inválido.'),
  male_max: z.number().int().positive('Informe o limite masculino.'),
  female_max: z.number().int().positive('Informe o limite feminino.'),
  starts_at: z.string().optional().nullable(),
  ends_at: z.string().optional().nullable(),
  male_closed: z.boolean().default(false),
  female_closed: z.boolean().default(false),
});

const singleTicketBatchUpdateSchema = z.object({
  batch_id: z.string().uuid(),
  name: z.string().trim().min(1, 'Informe o nome do lote.'),
  male_price: z.number().min(0, 'Preço masculino inválido.'),
  female_price: z.number().min(0, 'Preço feminino inválido.'),
  male_max: z.number().int().positive('Informe o limite masculino.'),
  female_max: z.number().int().positive('Informe o limite feminino.'),
  starts_at: z.string().optional().nullable(),
  ends_at: z.string().optional().nullable(),
});

const singleTicketBatchGenderClosedSchema = z.object({
  batch_id: z.string().uuid(),
  event_id: z.string().uuid(),
  gender: z.enum(['male', 'female']),
  closed: z.boolean(),
});

export async function createSingleTicketBatchAction(payload: z.infer<typeof singleTicketBatchCreateSchema>) {
  await assertPermission("batches.create");
  const parsed = singleTicketBatchCreateSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? 'Dados inválidos do lote.' };
  }
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('create_single_ticket_batch', {
      p_event_id: parsed.data.event_id,
      p_name: parsed.data.name,
      p_sequence_number: parsed.data.sequence_number,
      p_male_price: parsed.data.male_price,
      p_female_price: parsed.data.female_price,
      p_male_max: parsed.data.male_max,
      p_female_max: parsed.data.female_max,
      p_starts_at: parsed.data.starts_at || null,
      p_ends_at: parsed.data.ends_at || null,
      p_male_closed: parsed.data.male_closed,
      p_female_closed: parsed.data.female_closed,
    });
    if (error) throw error;
    await revalidateEventsPages();
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);
    revalidatePath('/inscricao');
    revalidatePath('/importacoes');
    return { success: true, message: 'Lote criado.' };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, 'Falha ao criar o lote.') };
  }
}

export async function updateSingleTicketBatchAction(eventId: string, payload: z.infer<typeof singleTicketBatchUpdateSchema>) {
  await assertPermission("batches.edit");
  const parsed = singleTicketBatchUpdateSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? 'Dados inválidos do lote.' };
  }
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('update_single_ticket_batch', {
      p_batch_id: parsed.data.batch_id,
      p_name: parsed.data.name,
      p_male_price: parsed.data.male_price,
      p_female_price: parsed.data.female_price,
      p_male_max: parsed.data.male_max,
      p_female_max: parsed.data.female_max,
      p_starts_at: parsed.data.starts_at || null,
      p_ends_at: parsed.data.ends_at || null,
    });
    if (error) throw error;
    await revalidateEventsPages();
    revalidatePath(`/painel/eventos/${eventId}`);
    revalidatePath('/inscricao');
    return { success: true, message: 'Lote atualizado.' };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, 'Falha ao atualizar o lote.') };
  }
}

export async function setSingleTicketBatchGenderClosedAction(payload: z.infer<typeof singleTicketBatchGenderClosedSchema>) {
  await assertPermission("batches.activate");
  const parsed = singleTicketBatchGenderClosedSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? 'Dados inválidos.' };
  }
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc('set_single_ticket_batch_gender_closed', {
      p_batch_id: parsed.data.batch_id,
      p_gender: parsed.data.gender,
      p_closed: parsed.data.closed,
    });
    if (error) throw error;
    await revalidateEventsPages();
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);
    revalidatePath('/inscricao');
    return {
      success: true,
      message: parsed.data.closed
        ? `${parsed.data.gender === 'male' ? 'Masculino' : 'Feminino'} encerrado neste lote.`
        : `${parsed.data.gender === 'male' ? 'Masculino' : 'Feminino'} reaberto neste lote.`,
    };
  } catch (error) {
    return { success: false, message: resolveActionErrorMessage(error, 'Falha ao alterar o status do lote.') };
  }
}

export async function upsertEventAddonsConfigAction(payload: {
  event_id: string;
  apply_to_all_batches: boolean;
  kit_enabled: boolean;
  custom_cup_enabled: boolean;
  gifts_enabled: boolean;
}) {
  await assertPermission("events.edit");
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
  await assertPermission("events.edit");
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
  await assertPermission("events.edit");
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
  await assertPermission("events.edit");
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
  await assertPermission("events.edit");
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
  await assertPermission("events.edit");
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
  await assertPermission("events.edit");
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
  await assertPermission("events.edit");
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
  await assertPermission("events.edit");
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
  await assertPermission("events.edit");
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

const shirtKitPairSchema = z.object({
  shirt_type: z.enum(["Camiseta", "Babylook"]),
  shirt_size: z.enum(["PP", "P", "M", "G", "GG", "EG", "EXG", "EXGG"]),
});

const shirtKitConfigurationSchema = z.object({
  event_id: z.string().uuid(),
  supply_mode: z.enum(["stock", "made_to_order", "disabled"]),
  is_required: z.boolean(),
  quantity_per_participant: z.number().int().min(1),
  pairs: z.array(shirtKitPairSchema).min(1, "Selecione ao menos um tamanho."),
});

export async function saveEventShirtKitConfigurationAction(payload: z.infer<typeof shirtKitConfigurationSchema>) {
  await assertPermission("events.edit");
  const parsed = shirtKitConfigurationSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false as const, message: parsed.error.issues[0]?.message ?? "Dados inválidos da configuração de camiseta." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("save_event_shirt_kit_configuration", {
      p_event_id: parsed.data.event_id,
      p_supply_mode: parsed.data.supply_mode,
      p_is_required: parsed.data.is_required,
      p_quantity_per_participant: parsed.data.quantity_per_participant,
      p_pairs: parsed.data.pairs,
    });
    if (error) throw error;
    revalidatePath('/eventos');
    revalidatePath('/painel/eventos');
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);
    revalidatePath("/inscricoes/nova");
    revalidatePath("/camisetas");
    const blockedRemovals = Array.isArray((data as { blocked_removals?: unknown[] } | null)?.blocked_removals)
      ? ((data as { blocked_removals: Array<{ shirt_type: string; shirt_size: string; reason: string }> }).blocked_removals)
      : [];
    return { success: true as const, message: "Configuração de camiseta salva.", blockedRemovals };
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : "Falha ao salvar a configuração de camiseta." };
  }
}

const attractionSchema = z.object({
  id: z.string().uuid().optional(),
  event_id: z.string().uuid(),
  name: z.string().trim().min(1, "Informe o nome da atração."),
  description: z.string().optional().nullable(),
  banner_url: z.string().optional().nullable(),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().default(0),
});

export async function upsertEventAttractionAction(payload: z.infer<typeof attractionSchema>) {
  await assertPermission("events.edit");
  const parsed = attractionSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("upsert_event_attraction", {
      p_id: parsed.data.id ?? null,
      p_event_id: parsed.data.event_id,
      p_name: parsed.data.name,
      p_description: parsed.data.description ?? null,
      p_banner_url: parsed.data.banner_url ?? null,
      p_is_active: parsed.data.is_active,
      p_sort_order: parsed.data.sort_order,
    });

    if (error) throw error;

    revalidatePath('/eventos');
    revalidatePath(`/eventos/${parsed.data.event_id}`);
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);
    return { success: true, message: parsed.data.id ? "Atração atualizada." : "Atração criada." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao salvar atração." };
  }
}

export async function deleteEventAttractionAction(payload: { event_id: string; attraction_id: string }) {
  await assertPermission("events.edit");
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("delete_event_attraction", {
      p_event_id: payload.event_id,
      p_attraction_id: payload.attraction_id,
    });

    if (error) throw error;

    revalidatePath('/eventos');
    revalidatePath(`/painel/eventos/${payload.event_id}`);
    return { success: true, message: "Atração removida." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao remover atração." };
  }
}
