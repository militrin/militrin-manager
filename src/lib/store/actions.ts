"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getPaymentProvider } from "@/lib/payments/get-provider";

const paymentProvider = getPaymentProvider();

export type StoreCartLine = { storeItemId: string; variantId: string | null; quantity: number };

export async function createAccountStoreOrderAction(input: { eventId: string; items: StoreCartLine[]; paymentMethod: "pix" | "credit_card" }) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_store_order", {
    p_event_id: input.eventId,
    p_items: input.items.map((item) => ({ store_item_id: item.storeItemId, variant_id: item.variantId, quantity: item.quantity })),
    p_payment_method: input.paymentMethod,
  });
  if (error) return { success: false as const, message: error.message };
  const result = Array.isArray(data) ? data[0] : data;
  revalidatePath("/minha-conta/loja");
  return {
    success: true as const,
    message: "Pedido criado.",
    storeOrderId: String(result?.store_order_id ?? ""),
    orderNumber: String(result?.order_number ?? ""),
    finalAmount: Number(result?.final_amount ?? 0),
  };
}

export async function generateStoreOrderPixAction(storeOrderId: string, amount: number) {
  const supabase = await createServerSupabaseClient();
  const payload = await paymentProvider.createPix({ participantId: storeOrderId, amount, expiresInMinutes: 120 });

  const { data, error } = await supabase.rpc("start_store_order_payment_pix", {
    p_store_order_id: storeOrderId,
    p_pix_code: payload.pixCode,
    p_pix_qrcode: payload.pixQrCode,
    p_gateway_payment_id: payload.gatewayPaymentId,
    p_expires_at: payload.expiresAt,
  });
  if (error) return { success: false as const, message: error.message };
  const order = Array.isArray(data) ? data[0] : data;
  return {
    success: true as const,
    pixCode: String(order?.pix_code ?? ""),
    pixQrCode: String(order?.pix_qrcode ?? ""),
    expiresAt: order?.expires_at ? String(order.expires_at) : null,
  };
}

export async function simulateStoreOrderPaymentAction(storeOrderId: string, method: "pix" | "credit_card") {
  if (process.env.NODE_ENV !== "development") {
    return { success: false as const, message: "A confirmacao simulada esta disponivel apenas em desenvolvimento." };
  }
  const supabase = await createServerSupabaseClient();
  await paymentProvider.confirmPayment({ participantId: storeOrderId, method });
  const { error } = await supabase.rpc("simulate_store_order_payment", { p_store_order_id: storeOrderId, p_payment_method: method });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/minha-conta/loja");
  return { success: true as const, message: "Pagamento confirmado (simulado)." };
}

export async function cancelAccountStoreOrderAction(storeOrderId: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("cancel_store_order", { p_store_order_id: storeOrderId, p_reason: "Cancelado pelo participante" });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/minha-conta/loja");
  return { success: true as const, message: "Pedido cancelado." };
}
