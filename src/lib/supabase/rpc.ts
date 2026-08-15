import { createClient } from "@/lib/supabase/client";

export async function createRegistrationWithRpc(values: {
  event_id: string;
  full_name: string;
  cpf: string;
  birth_date: string;
  gender?: string | null;
  phone: string;
  email: string;
  city?: string | null;
  shirt_type: string;
  shirt_size: string;
  payment_method: string;
  payment_status: string;
  coupon_code?: string | null;
  notes?: string | null;
}) {
  const supabase = createClient();
  if (!values.event_id) throw new Error("Selecione um evento.");

  const { data, error } = await supabase.rpc("create_registration", {
    p_full_name: values.full_name,
    p_cpf: values.cpf,
    p_birth_date: values.birth_date,
    p_gender: values.gender ?? null,
    p_phone: values.phone,
    p_email: values.email,
    p_city: values.city ?? null,
    p_shirt_type: values.shirt_type,
    p_shirt_size: values.shirt_size,
    p_registration_status: values.payment_status === "paid" ? "confirmed" : "pending",
    p_notes: values.notes ?? null,
    p_payment_method: values.payment_method,
    p_payment_status: values.payment_status,
    p_event_id: values.event_id,
    p_coupon_code: values.coupon_code ?? null,
  });

  if (error) throw error;
  return data as string;
}

export async function deliverKitWithRpc(ticketId: string) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("deliver_ticket_full_kit", { p_ticket_id: ticketId });
  if (error) throw error;
  return data as boolean;
}
