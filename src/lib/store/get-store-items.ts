import type { createServerSupabaseClient } from '@/lib/supabase/server';
import type { StoreItemDiscountType } from './pricing';

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

export type StoreItemImage = {
  id: string;
  url: string;
  isPrimary: boolean;
};

export type StoreItemForPurchase = {
  id: string;
  /** null quando o item e oferecido em todos os eventos da organizacao. */
  eventId: string | null;
  name: string;
  description: string | null;
  /** Imagem principal (conveniencia para cards; mesma imagem que aparece marcada como principal em `images`). */
  imageUrl: string | null;
  /** Galeria completa, ja ordenada. Vazia quando o item nao tem nenhuma imagem. */
  images: StoreItemImage[];
  price: number;
  /** Desconto intrinseco do produto (sempre aplicado, independente de cupom) -- fonte de public.compute_store_item_final_price via computeStoreItemFinalPrice (src/lib/store/pricing.ts). */
  discountType: StoreItemDiscountType;
  discountValue: number;
  requiresVariant: boolean;
  supplyMode: StoreSupplyMode;
  variants: StoreItemVariant[];
  /** null quando o item e "por encomenda" (sem limite de estoque). */
  availableQuantity: number | null;
};

/** eventId null retorna somente o catalogo global (produtos "Todos os eventos") -- a propria RPC ja resolve isso (`event_id = p_event_id or event_id is null`, que colapsa em so `event_id is null` quando p_event_id e null). */
export async function getStoreItemsForEvent(supabase: ServerSupabaseClient, eventId: string | null): Promise<StoreItemForPurchase[]> {
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
        images: (Array.isArray(row.images) ? row.images : []).map((image) => {
          const img = image as Record<string, unknown>;
          return { id: String(img.id), url: String(img.url), isPrimary: Boolean(img.is_primary) };
        }),
        price: Number(row.price ?? 0),
        discountType: row.discount_type === 'percentage' || row.discount_type === 'fixed' ? row.discount_type : null,
        discountValue: Number(row.discount_value ?? 0),
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
