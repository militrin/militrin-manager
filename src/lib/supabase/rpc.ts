import { createClient } from "@/lib/supabase/client";

export async function deliverKitWithRpc(ticketId: string) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("deliver_ticket_full_kit", { p_ticket_id: ticketId });
  if (error) throw error;
  return data as boolean;
}
