import type { createServerSupabaseClient } from '@/lib/supabase/server';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export const ACCOUNT_STORE_ORDERS_SELECT =
  'id, order_number, display_number, status, payment_method, payment_status, final_amount, pix_code, pix_qrcode, expires_at, created_at, event_id, events(name), store_order_items(id, quantity, unit_price, final_amount, status, store_items(name), store_item_variants(name, value))';

export async function getAccountStoreOrders(supabase: ServerSupabaseClient, userId: string) {
  return supabase
    .from('store_orders')
    .select(ACCOUNT_STORE_ORDERS_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
}
