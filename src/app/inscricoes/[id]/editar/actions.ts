"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function updateParticipantWithStock(payload: {
  id: string;
  full_name: string;
  birth_date: string | null;
  phone: string;
  email: string;
  city: string | null;
  gender: string | null;
  shirt_type: string;
  shirt_size: string;
  notes: string | null;
  amount: number;
  payment_method: string | null;
  payment_status: string;
}) {
  const supabase = await createServerSupabaseClient();
  const { data: participant, error: participantError } = await supabase.from("participants").select("id, shirt_type, shirt_size, event_id").eq("id", payload.id).single();
  if (participantError || !participant) throw participantError ?? new Error("Participante não encontrado.");

  const { data: currentStock, error: stockError } = await supabase.from("shirt_inventory").select("id, total_quantity, reserved_quantity, delivered_quantity").eq("event_id", participant.event_id).eq("shirt_type", participant.shirt_type).eq("shirt_size", participant.shirt_size).maybeSingle();
  if (stockError) throw stockError;

  const { data: nextStock, error: nextStockError } = await supabase.from("shirt_inventory").select("id, total_quantity, reserved_quantity, delivered_quantity").eq("event_id", participant.event_id).eq("shirt_type", payload.shirt_type).eq("shirt_size", payload.shirt_size).maybeSingle();
  if (nextStockError) throw nextStockError;

  if (currentStock && currentStock.id !== nextStock?.id) {
    const currentAvailable = currentStock.total_quantity - currentStock.reserved_quantity - currentStock.delivered_quantity;
    if (currentAvailable <= 0) throw new Error("Não há estoque disponível para a camiseta anterior.");
    await supabase.from("shirt_inventory").update({ reserved_quantity: currentStock.reserved_quantity - 1, updated_at: new Date().toISOString() }).eq("id", currentStock.id);
  }

  if (nextStock) {
    await supabase.from("shirt_inventory").update({ reserved_quantity: (nextStock.reserved_quantity ?? 0) + 1, updated_at: new Date().toISOString() }).eq("id", nextStock.id);
  }

  const { error: updateParticipantError } = await supabase.from("participants").update({
    full_name: payload.full_name,
    birth_date: payload.birth_date,
    phone: payload.phone,
    email: payload.email.trim().toLowerCase(),
    city: payload.city,
    gender: payload.gender,
    shirt_type: payload.shirt_type,
    shirt_size: payload.shirt_size,
    notes: payload.notes,
    amount: payload.amount,
  }).eq("id", payload.id);

  if (updateParticipantError) throw updateParticipantError;

  const { error: paymentError } = await supabase.from("payments").update({
    amount: payload.amount,
    payment_method: payload.payment_method,
    payment_status: payload.payment_status,
  }).eq("participant_id", payload.id);

  if (paymentError) throw paymentError;

  await supabase.from("audit_logs").insert({
    actor: "system",
    action: "participant_updated",
    entity_type: "participants",
    entity_id: payload.id,
    details: {
      shirt_type: payload.shirt_type,
      shirt_size: payload.shirt_size,
      payment_status: payload.payment_status,
    },
  });

  return true;
}
