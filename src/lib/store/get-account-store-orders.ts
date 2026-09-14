import type { createServerSupabaseClient } from '@/lib/supabase/server';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export const ACCOUNT_STORE_ORDER_PATH = '/minha-conta/compras/loja';

export function accountStoreOrderHref(storeOrderId: string) {
  return `${ACCOUNT_STORE_ORDER_PATH}/${storeOrderId}`;
}

export function accountStoreItemHref(storeOrderId: string, itemId: string) {
  return `${ACCOUNT_STORE_ORDER_PATH}/${storeOrderId}/itens/${itemId}`;
}

export const ACCOUNT_STORE_ORDERS_SELECT =
  'id, order_number, display_number, status, payment_method, payment_status, final_amount, pix_code, pix_qrcode, expires_at, created_at, event_id, events(name), store_order_items(id, quantity, unit_price, final_amount, status, delivered_at, pickup_qr_mode, store_items(name, store_item_images(image_url, is_primary, sort_order)), store_item_variants(name, value))';

export async function getAccountStoreOrders(supabase: ServerSupabaseClient, userId: string) {
  return supabase
    .from('store_orders')
    .select(ACCOUNT_STORE_ORDERS_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
}
