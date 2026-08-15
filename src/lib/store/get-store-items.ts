import type { createServerSupabaseClient } from '@/lib/supabase/server';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export type StoreSupplyMode = 'stock' | 'made_to_order';

export type StoreItemVariant = {
  id: string;
  name: string;
  value: string;
  priceAdjustment: number;
  /** null quando o item e "por encomenda" (sem limite de estoque). */
  availableQuantity: number | null;
};

export type StoreItemForPurchase = {
  id: string;
  /** null quando o item e oferecido em todos os eventos da organizacao. */
  eventId: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  price: number;
  requiresVariant: boolean;
  supplyMode: StoreSupplyMode;
  variants: StoreItemVariant[];
  /** null quando o item e "por encomenda" (sem limite de estoque). */
  availableQuantity: number | null;
};

export async function getStoreItemsForEvent(supabase: ServerSupabaseClient, eventId: string): Promise<StoreItemForPurchase[]> {
  const { data, error } = await supabase.rpc('list_store_items_for_event', { p_event_id: eventId });
  if (error) return [];

  const itemsById = new Map<string, StoreItemForPurchase>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const itemId = String(row.store_item_id);
    let item = itemsById.get(itemId);
    if (!item) {
      item = {
        id: itemId,
        eventId: row.event_id ? String(row.event_id) : null,
        name: String(row.name ?? ''),
        description: row.description ? String(row.description) : null,
        imageUrl: row.image_url ? String(row.image_url) : null,
        price: Number(row.price ?? 0),
        requiresVariant: Boolean(row.requires_variant),
        supplyMode: row.supply_mode === 'made_to_order' ? 'made_to_order' : 'stock',
        variants: [],
        availableQuantity: 0,
      };
      itemsById.set(itemId, item);
    }
    const availableQuantity = row.available_quantity === null || row.available_quantity === undefined ? null : Number(row.available_quantity);
    if (row.variant_id) {
      item.variants.push({
        id: String(row.variant_id),
        name: String(row.variant_name ?? ''),
        value: String(row.variant_value ?? ''),
        priceAdjustment: Number(row.price_adjustment ?? 0),
        availableQuantity,
      });
    } else {
      item.availableQuantity = availableQuantity;
    }
  }
  return Array.from(itemsById.values());
}

/** Junta o catalogo de varios eventos em um so (usado na visao "Todos os itens" da conta do participante). Itens de todos os eventos (event_id nulo) aparecem uma unica vez mesmo sendo retornados por cada chamada. */
export async function getStoreItemsForEvents(supabase: ServerSupabaseClient, eventIds: string[]): Promise<StoreItemForPurchase[]> {
  const lists = await Promise.all(eventIds.map((eventId) => getStoreItemsForEvent(supabase, eventId)));
  const itemsById = new Map<string, StoreItemForPurchase>();
  for (const list of lists) {
    for (const item of list) {
      if (!itemsById.has(item.id)) itemsById.set(item.id, item);
    }
  }
  return Array.from(itemsById.values());
}
