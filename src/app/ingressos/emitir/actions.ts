"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { buildShirtInventoryVariants, getShirtTypeOrder } from "@/lib/constants/shirts";
import { registrationContactHasActiveTicket } from "@/lib/registrations/active-ticket-holder";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pinPattern = /^[A-Z0-9]{10}$/;

function normalizePin(value: string) {
  return value.trim().toUpperCase();
}

export type IssueTicketReason = "courtesy" | "system_failure" | "administrative_correction" | "other";

export async function getEventShirtOptionsAction(eventId: string) {
  await assertPermission("participants.view");
  if (!uuid.test(eventId)) return { success: false as const, message: "Evento inválido." };

  const supabase = await createServerSupabaseClient();
  const [{ data: event, error: eventError }, { data: hasShirtItemRows, error: kitItemsError }, { data: inventoryRows, error: inventoryError }] = await Promise.all([
    supabase.from("events").select("limit_shirt_selection_to_stock").eq("id", eventId).maybeSingle(),
    supabase.from("event_kit_items").select("id").eq("event_id", eventId).eq("item_type", "shirt").eq("is_active", true).limit(1),
    supabase.from("shirt_inventory").select("shirt_type,shirt_size,total_quantity,reserved_quantity,delivered_quantity").eq("event_id", eventId),
  ]);
  if (eventError) return { success: false as const, message: eventError.message };
  if (kitItemsError) return { success: false as const, message: kitItemsError.message };
  if (inventoryError) return { success: false as const, message: inventoryError.message };

  const hasShirts = (hasShirtItemRows ?? []).length > 0;
  const limitToStock = Boolean(event?.limit_shirt_selection_to_stock);

  const optionsMap = new Map<string, string[]>();
  if (hasShirts) {
    const variants = buildShirtInventoryVariants(inventoryRows ?? []).filter((variant) => !limitToStock || variant.available_quantity > 0);
    for (const variant of variants) {
      optionsMap.set(variant.shirt_type, [...(optionsMap.get(variant.shirt_type) ?? []), variant.shirt_size]);
    }
  }

  return {
    success: true as const,
    hasShirts,
    limitToStock,
    options: Array.from(optionsMap, ([type, sizes]) => ({ type, sizes }))
      .sort((a, b) => getShirtTypeOrder(a.type) - getShirtTypeOrder(b.type)),
  };
}

export async function lookupRegistrationContactAction(pin: string) {
  await assertPermission("participants.view");
  const normalized = normalizePin(pin);
  if (!pinPattern.test(normalized)) return { success: false as const, message: "PIN inválido." };

  const org = (await getCurrentOrganizationContext()).organization;
  if (!org?.id) return { success: false as const, message: "Selecione uma organização." };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("registration_contacts")
    .select("id,full_name,cpf")
    .eq("public_pin", normalized)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (error) return { success: false as const, message: error.message };
  if (!data) return { success: false as const, message: "Cadastro não encontrado nesta organização." };

  return { success: true as const, id: String(data.id), name: String(data.full_name ?? ""), cpf: String(data.cpf ?? "") };
}

export async function issueTicketAction(input: {
  pin: string;
  registrationContactId?: string | null;
  eventId: string;
  categoryId: string;
  batchId: string;
  quantity: number;
  reason: IssueTicketReason;
  pricingGender: string;
  shirtType: string;
  shirtSize: string;
  notes: string;
  assignHolder?: boolean;
}) {
  await assertPermission("participants.create");

  const quantity = Math.min(20, Math.max(1, Number(input.quantity) || 1));
  const normalizedPin = normalizePin(input.pin);
  const hasContactId = Boolean(input.registrationContactId && uuid.test(input.registrationContactId));
  if ((!hasContactId && !pinPattern.test(normalizedPin)) || !uuid.test(input.eventId) || !uuid.test(input.categoryId) || !uuid.test(input.batchId)) {
    return { success: false as const, message: "Preencha o PIN do cadastro, evento, categoria e lote corretamente." };
  }
  if (input.reason === "other" && !input.notes.trim()) {
    return { success: false as const, message: "Descreva o motivo em Observações quando escolher \"Outro motivo\"." };
  }

  const org = (await getCurrentOrganizationContext()).organization;
  if (!org?.id) return { success: false as const, message: "Selecione uma organização." };

  const supabase = await createServerSupabaseClient();
  let contactQuery = supabase.from("registration_contacts").select("*").eq("organization_id", org.id);
  contactQuery = hasContactId ? contactQuery.eq("id", input.registrationContactId as string) : contactQuery.eq("public_pin", normalizedPin);
  const contactResult = await contactQuery.maybeSingle();
  if (contactResult.error || !contactResult.data) {
    return { success: false as const, message: "Cadastro não encontrado nesta organização. Confira o PIN digitado." };
  }
  const assignHolder = input.assignHolder !== false;
  if (assignHolder) {
    try {
      const holderState = await registrationContactHasActiveTicket(supabase, input.eventId, String(contactResult.data.id));
      if (holderState.hasActiveTicket) {
        return {
          success: false as const,
          requiresHolderDecision: true as const,
          message: "Esta pessoa já é titular de outro ingresso neste evento.",
        };
      }
    } catch {
      return { success: false as const, message: "Não foi possível validar a titularidade desta pessoa." };
    }
  }
  const shirtType = input.shirtType.trim() || null;
  const shirtSize = input.shirtSize.trim() || null;
  const notes = input.notes.trim() || null;
  const { data, error } = await supabase.rpc("issue_manual_ticket_batch", {
    p_registration_contact_id: String(contactResult.data.id),
    p_event_id: input.eventId,
    p_ticket_category_id: input.categoryId,
    p_batch_id: input.batchId,
    p_quantity: quantity,
    p_pricing_gender: input.pricingGender,
    p_shirt_type: shirtType,
    p_shirt_size: shirtSize,
    p_payment_method: input.reason,
    p_notes: notes,
    p_assign_holder: assignHolder,
  });
  if (error) return { success: false as const, message: error.message ?? "Falha ao emitir ingressos." };
  const ticketRows = (data ?? []) as Array<{ ticket_id: unknown }>;
  const ticketIds = ticketRows.map((row) => String(row.ticket_id));
  if (ticketIds.length !== quantity) return { success: false as const, message: "A emissao nao retornou todos os ingressos esperados." };

  return {
    success: true as const,
    message: `${quantity} ingresso(s) emitido(s) com sucesso.`,
    ticketIds,
  };
}
