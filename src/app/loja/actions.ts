"use server";

import { revalidatePath } from "next/cache";
import { assertPermission } from "@/lib/admin/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function upsertStoreItemAction(input: {
  id: string | null;
  eventId: string;
  name: string;
  slug: string;
  description: string;
  price: number;
  requiresVariant: boolean;
  isActive: boolean;
  sortOrder: number;
  supplyMode: "stock" | "made_to_order";
  availableAllEvents: boolean;
}) {
  await assertPermission("store.manage");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("upsert_store_item", {
    p_id: input.id,
    p_event_id: input.eventId,
    p_name: input.name,
    p_slug: input.slug,
    p_description: input.description || null,
    p_price: input.price,
    p_requires_variant: input.requiresVariant,
    p_is_active: input.isActive,
    p_sort_order: input.sortOrder,
    p_supply_mode: input.supplyMode,
    p_available_all_events: input.availableAllEvents,
  });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Item salvo.", storeItemId: data as string };
}

export async function addStoreItemImageAction(storeItemId: string, imageUrl: string) {
  await assertPermission("store.manage");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("add_store_item_image", { p_store_item_id: storeItemId, p_image_url: imageUrl });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Imagem adicionada." };
}

export async function removeStoreItemImageAction(imageId: string) {
  await assertPermission("store.manage");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("remove_store_item_image", { p_image_id: imageId });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Imagem removida." };
}

export async function setStoreItemPrimaryImageAction(imageId: string) {
  await assertPermission("store.manage");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_store_item_primary_image", { p_image_id: imageId });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Imagem principal atualizada." };
}

export async function reorderStoreItemImagesAction(storeItemId: string, imageIds: string[]) {
  await assertPermission("store.manage");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("reorder_store_item_images", { p_store_item_id: storeItemId, p_image_ids: imageIds });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Ordem atualizada." };
}

export async function upsertStoreItemVariantAction(input: {
  id: string | null;
  storeItemId: string;
  name: string;
  value: string;
  priceAdjustment: number;
  isActive: boolean;
  sortOrder: number;
}) {
  await assertPermission("store.manage");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("upsert_store_item_variant", {
    p_id: input.id,
    p_store_item_id: input.storeItemId,
    p_name: input.name,
    p_value: input.value,
    p_price_adjustment: input.priceAdjustment,
    p_is_active: input.isActive,
    p_sort_order: input.sortOrder,
  });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Variante salva." };
}

export async function setStoreItemStockAction(input: { storeItemId: string; variantId: string | null; totalQuantity: number }) {
  await assertPermission("store.manage");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_store_item_stock", {
    p_store_item_id: input.storeItemId,
    p_variant_id: input.variantId,
    p_total_quantity: input.totalQuantity,
  });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Estoque atualizado." };
}

export async function confirmStoreOrderPaymentAction(storeOrderId: string) {
  await assertPermission("store.manage");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("confirm_store_order_payment", { p_store_order_id: storeOrderId });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Pagamento confirmado." };
}

export async function cancelStoreOrderAction(storeOrderId: string, reason: string) {
  await assertPermission("store.manage");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("cancel_store_order", { p_store_order_id: storeOrderId, p_reason: reason });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Pedido cancelado." };
}

export async function deliverStoreOrderItemAction(storeOrderItemId: string) {
  await assertPermission("store.deliver");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("deliver_store_order_item", { p_store_order_item_id: storeOrderItemId });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Item entregue." };
}

export async function undoStoreOrderItemDeliveryAction(storeOrderItemId: string) {
  await assertPermission("store.deliver");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("undo_store_order_item_delivery", { p_store_order_item_id: storeOrderItemId });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/loja");
  return { success: true as const, message: "Entrega desfeita." };
}
