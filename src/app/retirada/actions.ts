"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";
import { ticketHasOpenIssueBlock } from "@/lib/account/ticket-operation-blocks";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";

function relation(value: unknown) {
  return (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
}

function pickupRpcError(error: { message?: string; details?: string | null }) {
  const serialized = `${error.message ?? ""} ${error.details ?? ""}`;
  if (!serialized.includes("SHIRT_OUT_OF_STOCK")) return error.message ?? "Operação não concluída.";
  try {
    const detail = JSON.parse(error.details ?? "{}") as { message?: string; shirt_type?: string; shirt_size?: string };
    return detail.message ?? `Não há estoque disponível para ${detail.shirt_type ?? "Camiseta"} ${detail.shirt_size ?? ""}. A entrega não foi confirmada.`;
  } catch {
    return "Não há estoque disponível para esta camiseta. A entrega não foi confirmada.";
  }
}

export async function getRetiradaCapabilitiesAction() {
  let canDeliverKit = false;
  let canCheckin = false;
  try { await assertPermission("kits.deliver"); canDeliverKit = true; } catch { canDeliverKit = false; }
  try { await assertPermission("checkin.scan"); canCheckin = true; } catch { canCheckin = false; }
  return { success: true, capabilities: { canDeliverKit, canCheckin, canCombined: canDeliverKit && canCheckin } };
}

export async function searchPickupParticipantAction(query: string) {
  await assertPermission("participants.view");
  const supabase = await createServerSupabaseClient();
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) return { success: false as const, message: "Organização não selecionada." };
  const q = query.trim();
  if (!q) return { success: false as const, message: "Informe nome, CPF, telefone ou QR/token." };

  const { data: directTicket } = await supabase.from("tickets").select("id").eq("token", q).eq("organization_id", organization.id).maybeSingle();
  if (directTicket?.id) return getPickupTicketAction(String(directTicket.id));

  const safeQuery = q.replace(/[,%()]/g, " ");
  const { data: contacts, error: contactsError } = await supabase.from("registration_contacts")
    .select("id,full_name,cpf,phone")
    .eq("organization_id", organization.id)
    .or(`full_name.ilike.%${safeQuery}%,cpf.ilike.%${safeQuery}%,phone.ilike.%${safeQuery}%`)
    .limit(20);
  if (contactsError) return { success: false as const, message: contactsError.message };
  if (!(contacts ?? []).length) return { success: false as const, message: "Nenhuma pessoa encontrada." };

  const contactIds = (contacts ?? []).map((contact) => String(contact.id));
  const [{ data: participants, error: participantsError }, { data: orderItems, error: orderItemsError }] = await Promise.all([
    supabase.from("participants").select("id,registration_contact_id").in("registration_contact_id", contactIds).range(0, 4999),
    supabase.from("order_items").select("id,registration_contact_id").in("registration_contact_id", contactIds).range(0, 4999),
  ]);
  if (participantsError) return { success: false as const, message: participantsError.message };
  if (orderItemsError) return { success: false as const, message: orderItemsError.message };

  const contactByParticipant = new Map((participants ?? []).map((row) => [String(row.id), String(row.registration_contact_id)]));
  const contactByOrderItem = new Map((orderItems ?? []).map((row) => [String(row.id), String(row.registration_contact_id)]));
  const participantIds = Array.from(contactByParticipant.keys());
  const orderItemIds = Array.from(contactByOrderItem.keys());
  const empty = { data: [] as Array<Record<string, unknown>>, error: null };
  const [participantTicketResult, orderItemTicketResult] = await Promise.all([
    participantIds.length ? supabase.from("tickets").select("id,event_id,status,used_at,participant_id,order_item_id,events(name),order_items(holder_full_name,shirt_type,shirt_size,ticket_categories(name)),participant_kit_items(status)").in("participant_id", participantIds).range(0, 4999) : Promise.resolve(empty),
    orderItemIds.length ? supabase.from("tickets").select("id,event_id,status,used_at,participant_id,order_item_id,events(name),order_items(holder_full_name,shirt_type,shirt_size,ticket_categories(name)),participant_kit_items(status)").in("order_item_id", orderItemIds).range(0, 4999) : Promise.resolve(empty),
  ]);
  if (participantTicketResult.error) return { success: false as const, message: participantTicketResult.error.message };
  if (orderItemTicketResult.error) return { success: false as const, message: orderItemTicketResult.error.message };

  const contactById = new Map((contacts ?? []).map((row) => [String(row.id), row]));
  const ticketsById = new Map<string, Record<string, unknown>>();
  for (const row of [...(participantTicketResult.data ?? []), ...(orderItemTicketResult.data ?? [])] as Array<Record<string, unknown>>) ticketsById.set(String(row.id), row);
  const candidates = Array.from(ticketsById.values()).flatMap((row) => {
    const contactId = (row.order_item_id ? contactByOrderItem.get(String(row.order_item_id)) : null)
      ?? (row.participant_id ? contactByParticipant.get(String(row.participant_id)) : null);
    const contact = contactId ? contactById.get(contactId) : null;
    if (!contactId || !contact) return [];
    const orderItem = relation(row.order_items);
    const kitItems = (Array.isArray(row.participant_kit_items) ? row.participant_kit_items : []) as Array<{ status?: string | null }>;
    return [{
      contact_id: contactId,
      person_name: String(contact.full_name ?? "Pessoa"),
      cpf: String(contact.cpf ?? ""),
      phone: String(contact.phone ?? ""),
      ticket_id: String(row.id),
      event_id: String(row.event_id),
      event_name: String(relation(row.events)?.name ?? "Evento"),
      category_name: String(relation(orderItem?.ticket_categories)?.name ?? "Sem categoria"),
      holder_name: String(orderItem?.holder_full_name ?? contact.full_name ?? "Titular não definido"),
      shirt: [orderItem?.shirt_type, orderItem?.shirt_size].filter(Boolean).join(" · "),
      kit_status: kitItems.length === 0 ? null : kitItems.every((item) => item.status === "delivered") ? "Entregue" : "Pendente",
      checkin_status: row.used_at || String(row.status) === "used" ? "Realizado" : "Pendente",
      ticket_status: String(row.status ?? "pending"),
    }];
  });
  if (candidates.length === 0) return { success: false as const, message: "Pessoa encontrada, mas sem ingresso elegível." };
  if (candidates.length === 1) return getPickupTicketAction(candidates[0].ticket_id);
  return { success: true as const, requires_selection: true as const, candidates };
}

export async function getPickupTicketAction(ticketId: string) {
  await assertPermission("participants.view");
  const supabase = await createServerSupabaseClient();
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) return { success: false as const, message: "Organização não selecionada." };
  const { data: ticket, error: ticketError } = await supabase.from("tickets").select("id,event_id,status,used_at,participant_id,order_item_id,events(name,kit_enabled,allow_checkin_during_kit_delivery),participants(id,full_name,registration_number,cpf,phone,payment_status,registration_status,shirt_type,shirt_size,ticket_categories(name)),order_items(holder_full_name,shirt_type,shirt_size,ticket_categories(name))").eq("id", ticketId).eq("organization_id", organization.id).maybeSingle();
  if (ticketError || !ticket) return { success: false as const, message: ticketError?.message ?? "Ingresso não encontrado." };
  const participant = relation(ticket.participants);
  const orderItem = relation(ticket.order_items);
  const event = relation(ticket.events);
  const participantId = participant?.id ? String(participant.id) : null;

  const { error: ensureKitError } = await supabase.rpc("ensure_ticket_kit_items", { p_ticket_id: ticketId });
  if (ensureKitError) return { success: false as const, message: "Nao foi possivel identificar todos os itens deste ingresso. Revise a camiseta antes da entrega." };

  const [{ data: kitItemsData, error: kitItemsError }, paymentResult, { data: checkinLogData, error: checkinLogError }] = await Promise.all([
    supabase.rpc("get_ticket_kit_items", { p_ticket_id: ticketId }),
    participantId ? supabase.rpc("get_participant_payment_details", { p_participant_id: participantId }) : Promise.resolve({ data: null, error: null }),
    supabase.from("audit_logs").select("id,actor,created_at").eq("entity_type", "tickets").eq("entity_id", ticketId).eq("action", "ticket_checkin_entry").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (kitItemsError) return { success: false as const, message: kitItemsError.message };
  if (paymentResult.error) return { success: false as const, message: paymentResult.error.message };
  if (checkinLogError) return { success: false as const, message: checkinLogError.message };

  const paymentRow = (Array.isArray(paymentResult.data) ? paymentResult.data[0] : paymentResult.data) as Record<string, unknown> | null;
  const paymentStatus = String(paymentRow?.payment_status ?? participant?.payment_status ?? "pending");
  const ticketStatus = String(ticket.status ?? "pending");
  const ticketUsedAt = ticket.used_at ? String(ticket.used_at) : null;
  const category = relation(orderItem?.ticket_categories);
  // LEGACY FALLBACK — do not use as canonical source: exclusively for historical records without a complete order_item.
  const legacyCategory = relation(participant?.ticket_categories);
  const shirtType = String(orderItem?.shirt_type ?? participant?.shirt_type ?? "");
  const shirtSize = String(orderItem?.shirt_size ?? participant?.shirt_size ?? "");
  const kitItems = (kitItemsData ?? []).map((item: Record<string, unknown>) => ({
    kit_item_id: String(item.kit_item_id), item_name: String(item.item_name), item_type: String(item.item_type),
    quantity: Number(item.quantity ?? 1), status: String(item.status ?? "reserved"), delivered_at: item.delivered_at ? String(item.delivered_at) : null,
  }));
  const blockReason = paymentStatus !== "paid" ? "Pagamento pendente."
    : String(participant?.registration_status ?? "pending") === "cancelled" ? "Inscrição cancelada."
    : ticketStatus === "used" || Boolean(ticketUsedAt) || Boolean(checkinLogData?.id) ? "Entrada já utilizada anteriormente." : null;

  return { success: true as const, participant: {
    id: participantId ?? ticketId, event_id: String(ticket.event_id), full_name: String(orderItem?.holder_full_name ?? participant?.full_name ?? "Titular não definido"),
    registration_number: participant?.registration_number == null ? null : Number(participant.registration_number), cpf: String(participant?.cpf ?? ""), phone: String(participant?.phone ?? ""),
    payment_status: paymentStatus, payment_method: String(paymentRow?.payment_method ?? "-"), registration_status: String(participant?.registration_status ?? "confirmed"),
    shirt_type: shirtType, shirt_size: shirtSize, category_name: String(category?.name ?? legacyCategory?.name ?? "Sem categoria"), event_name: String(event?.name ?? "Evento"),
    event_kit_enabled: Boolean(event?.kit_enabled), ticket_status: ticketStatus, ticket_id: ticketId, ticket_used_at: ticketUsedAt,
    last_checkin_at: checkinLogData?.created_at ? String(checkinLogData.created_at) : null, last_checkin_actor: checkinLogData?.actor ? String(checkinLogData.actor) : null,
    all_kit_delivered: kitItems.length > 0 && kitItems.every((item: { status: string }) => item.status === "delivered"), can_operate: blockReason === null, block_reason: blockReason,
    allow_checkin_during_kit_delivery: Boolean(event?.allow_checkin_during_kit_delivery), kit_items: kitItems,
  }};
}

export async function deliverKitAndCheckinAction(payload: { ticket_id: string }) {
  await assertPermission("kits.deliver"); await assertPermission("checkin.scan");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("deliver_items_and_checkin", { p_ticket_id: payload.ticket_id });
  if (error) return { success: false, message: pickupRpcError(error) };
  if (data !== true) return { success: false, message: "Não foi possível concluir a operação combinada.", kit_delivered: false, checkin_done: false };
  return { success: true, message: "Kit entregue e entrada confirmada.", kit_delivered: true, checkin_done: true };
}

export async function deliverKitItemAction(payload: { ticket_id: string; kit_item_id: string }) {
  await assertPermission("kits.deliver");
  const supabase = await createServerSupabaseClient();
  const [kitBlock, checkinBlock] = await Promise.all([ticketHasOpenIssueBlock(supabase, payload.ticket_id, "blocks_kit_delivery"), ticketHasOpenIssueBlock(supabase, payload.ticket_id, "blocks_checkin")]);
  if (kitBlock.error || checkinBlock.error || kitBlock.blocked || checkinBlock.blocked) return { success: false, message: "Operação bloqueada por pendência específica de entrega ou check-in." };
  const { error } = await supabase.rpc("deliver_ticket_kit_item", { p_ticket_id: payload.ticket_id, p_kit_item_id: payload.kit_item_id });
  if (error) return { success: false, message: pickupRpcError(error) };
  return { success: true, message: "Item entregue com sucesso." };
}

export async function deliverFullKitAction(payload: { ticket_id: string }) {
  await assertPermission("kits.deliver");
  const supabase = await createServerSupabaseClient();
  const issueBlock = await ticketHasOpenIssueBlock(supabase, payload.ticket_id, "blocks_kit_delivery");
  if (issueBlock.error || issueBlock.blocked) return { success: false, message: "Entrega bloqueada por pendência do cadastro." };
  const { data: pendingItems } = await supabase.from("participant_kit_items").select("id").eq("ticket_id", payload.ticket_id).neq("status", "delivered").limit(1);
  if ((pendingItems ?? []).length === 0) return { success: false, message: "Kit já foi entregue anteriormente." };
  const { error } = await supabase.rpc("deliver_ticket_full_kit", { p_ticket_id: payload.ticket_id });
  if (error) return { success: false, message: pickupRpcError(error) };
  return { success: true, message: "Kit completo entregue com sucesso." };
}

export async function checkinEntryAction(payload: { ticket_id: string }) {
  await assertPermission("checkin.scan");
  const supabase = await createServerSupabaseClient();
  const issueBlock = await ticketHasOpenIssueBlock(supabase, payload.ticket_id, "blocks_checkin");
  if (issueBlock.error || issueBlock.blocked) return { success: false, message: "Check-in bloqueado por pendência do cadastro." };
  const { error } = await supabase.rpc("checkin_ticket_entry", { p_ticket_id: payload.ticket_id });
  if (error) return { success: false, message: pickupRpcError(error) };
  return { success: true, message: `Entrada confirmada em ${new Date().toLocaleString("pt-BR")}.` };
}
