"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function releaseExpiredReservationsAction() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("release_expired_reservations");

  if (error) {
    console.error("ERRO AO LIBERAR RESERVAS EXPIRADAS:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
    });
    return { success: false, released: 0, message: error.message };
  }

  return { success: true, released: Number(data ?? 0), message: null as string | null };
}
