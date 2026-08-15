import { Sidebar } from "@/components/dashboard/Sidebar";
import { AdminEmptyState, AdminPageHeader, AdminSection } from "@/components/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentPermissionMap, requirePermission } from "@/lib/admin/permissions";
import { StoreEventSelector } from "./store-event-selector";
import { StoreItemForm } from "./store-item-form";
import { StoreItemCard } from "./store-item-card";
import { StoreOrdersList } from "./store-orders-list";

type EventOption = { id: string; name: string; year: number | null; is_active: boolean };

type StoreItemVariant = {
  id: string;
  name: string;
  value: string;
  priceAdjustment: number;
  totalQuantity: number;
  reservedQuantity: number;
  deliveredQuantity: number;
  availableQuantity: number;
};

type StoreItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  price: number;
  requiresVariant: boolean;
  sortOrder: number;
  supplyMode: "stock" | "made_to_order";
  eventId: string | null;
  eventLabel: string;
  variants: StoreItemVariant[];
  totalQuantity: number;
  reservedQuantity: number;
  deliveredQuantity: number;
  availableQuantity: number;
};

function eventLabelFor(events: EventOption[], eventId: string | null) {
  if (!eventId) return "Todos os eventos";
  const event = events.find((e) => e.id === eventId);
  return event ? `${event.name}${event.year ? ` ${event.year}` : ""}` : "Evento";
}

async function getStoreData(selectedEventId: string | null) {
  const supabase = await createServerSupabaseClient();

  const { data: eventsData, error: eventsError } = await supabase
    .from("events")
    .select("id, name, year, is_active")
    .order("is_active", { ascending: false })
    .order("year", { ascending: false });
  if (eventsError) throw eventsError;
  const events = (eventsData ?? []) as EventOption[];

  if (!selectedEventId) {
    const { data: rows, error: rowsError } = await supabase
      .from("store_items")
      .select(
        "id, event_id, name, slug, description, image_url, price, requires_variant, supply_mode, sort_order, store_item_variants(id, name, value, price_adjustment, sort_order, is_active), store_item_inventory(variant_id, total_quantity, reserved_quantity, delivered_quantity)"
      )
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (rowsError) throw rowsError;

    const items = ((rows ?? []) as Array<Record<string, unknown>>).map((row) => {
      const supplyMode = row.supply_mode === "made_to_order" ? "made_to_order" : "stock";
      const invRows = (Array.isArray(row.store_item_inventory) ? row.store_item_inventory : []) as Array<Record<string, unknown>>;
      const invByVariant = new Map<string | null, Record<string, unknown>>();
      for (const inv of invRows) invByVariant.set(inv.variant_id ? String(inv.variant_id) : null, inv);
      const availFor = (inv: Record<string, unknown> | undefined) => {
        const total = Number(inv?.total_quantity ?? 0);
        const reserved = Number(inv?.reserved_quantity ?? 0);
        const delivered = Number(inv?.delivered_quantity ?? 0);
        return { total, reserved, delivered, available: supplyMode === "made_to_order" ? 0 : Math.max(total - reserved - delivered, 0) };
      };
      const variantRows = ((Array.isArray(row.store_item_variants) ? row.store_item_variants : []) as Array<Record<string, unknown>>)
        .filter((v) => v.is_active !== false)
        .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
      const variants: StoreItemVariant[] = variantRows.map((v) => {
        const q = availFor(invByVariant.get(String(v.id)));
        return {
          id: String(v.id), name: String(v.name ?? ""), value: String(v.value ?? ""), priceAdjustment: Number(v.price_adjustment ?? 0),
          totalQuantity: q.total, reservedQuantity: q.reserved, deliveredQuantity: q.delivered, availableQuantity: q.available,
        };
      });
      const base = availFor(invByVariant.get(null));
      const eventId = row.event_id ? String(row.event_id) : null;
      return {
        id: String(row.id),
        name: String(row.name ?? ""),
        slug: String(row.slug ?? ""),
        description: row.description ? String(row.description) : null,
        imageUrl: row.image_url ? String(row.image_url) : null,
        price: Number(row.price ?? 0),
        requiresVariant: Boolean(row.requires_variant),
        sortOrder: Number(row.sort_order ?? 0),
        supplyMode,
        eventId,
        eventLabel: eventLabelFor(events, eventId),
        variants,
        totalQuantity: base.total, reservedQuantity: base.reserved, deliveredQuantity: base.delivered, availableQuantity: base.available,
      } satisfies StoreItem;
    }).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    return { events, selectedEventId: null, items, orders: [] as Array<Record<string, unknown>> };
  }

  const [{ data: rows, error: rowsError }, { data: orderRows, error: ordersError }] = await Promise.all([
    supabase.rpc("list_store_items_for_event", { p_event_id: selectedEventId }),
    supabase
      .from("store_orders")
      .select("id, order_number, status, payment_method, payment_status, final_amount, created_at, confirmed_at, store_order_items(id, quantity, unit_price, final_amount, status, store_items(name), store_item_variants(name, value))")
      .eq("event_id", selectedEventId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  if (rowsError) throw rowsError;
  if (ordersError) throw ordersError;

  const itemsById = new Map<string, StoreItem>();
  for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
    const itemId = String(row.store_item_id);
    let item = itemsById.get(itemId);
    if (!item) {
      const eventId = row.event_id ? String(row.event_id) : null;
      item = {
        id: itemId,
        name: String(row.name ?? ""),
        slug: String(row.slug ?? ""),
        description: row.description ? String(row.description) : null,
        imageUrl: row.image_url ? String(row.image_url) : null,
        price: Number(row.price ?? 0),
        requiresVariant: Boolean(row.requires_variant),
        sortOrder: Number(row.sort_order ?? 0),
        supplyMode: row.supply_mode === "made_to_order" ? "made_to_order" : "stock",
        eventId,
        eventLabel: eventId ? eventLabelFor(events, eventId) : "Todos os eventos",
        variants: [],
        totalQuantity: 0,
        reservedQuantity: 0,
        deliveredQuantity: 0,
        availableQuantity: 0,
      };
      itemsById.set(itemId, item);
    }
    if (row.variant_id) {
      item.variants.push({
        id: String(row.variant_id),
        name: String(row.variant_name ?? ""),
        value: String(row.variant_value ?? ""),
        priceAdjustment: Number(row.price_adjustment ?? 0),
        totalQuantity: Number(row.total_quantity ?? 0),
        reservedQuantity: Number(row.reserved_quantity ?? 0),
        deliveredQuantity: Number(row.delivered_quantity ?? 0),
        availableQuantity: Number(row.available_quantity ?? 0),
      });
    } else if (!item.requiresVariant) {
      item.totalQuantity = Number(row.total_quantity ?? 0);
      item.reservedQuantity = Number(row.reserved_quantity ?? 0);
      item.deliveredQuantity = Number(row.delivered_quantity ?? 0);
      item.availableQuantity = Number(row.available_quantity ?? 0);
    }
  }
  const items = Array.from(itemsById.values()).sort((a, b) => a.sortOrder - b.sortOrder);

  return { events, selectedEventId, items, orders: orderRows ?? [] };
}

export default async function LojaPage({ searchParams }: { searchParams?: Promise<{ eventId?: string }> }) {
  await requirePermission("store.view");
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const selectedEventId = typeof resolvedSearchParams.eventId === "string" ? resolvedSearchParams.eventId : null;
  const { events, items, orders } = await getStoreData(selectedEventId);
  const permissionMap = await getCurrentPermissionMap(["store.manage", "store.deliver"]);
  const canManage = Boolean(permissionMap["store.manage"]);
  const canDeliver = Boolean(permissionMap["store.deliver"]);

  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? null;
  const selectedEventLabel = selectedEvent ? `${selectedEvent.name}${selectedEvent.year ? ` ${selectedEvent.year}` : ""}` : "Todos os eventos";

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader title="Loja" subtitle="Itens opcionais vendidos avulsos ou junto com o ingresso" />

          <AdminSection title="Evento" description={`Evento selecionado: ${selectedEventLabel}`}>
            <StoreEventSelector events={events} selectedEventId={selectedEventId} />
          </AdminSection>

          <AdminSection
            title="Catálogo"
            description={selectedEventId ? `Itens opcionais disponíveis para ${selectedEventLabel}` : "Todos os itens cadastrados, de qualquer evento"}
            actions={canManage && selectedEventId ? <StoreItemForm eventId={selectedEventId} eventLabel={selectedEventLabel} item={null} /> : null}
          >
            {!selectedEventId && canManage ? (
              <p className="mb-3 text-xs text-slate-500">Selecione um evento acima para cadastrar um item novo ou editar nome, preço e disponibilidade. Estoque e variantes podem ser ajustados aqui em qualquer modo.</p>
            ) : null}
            {items.length === 0 ? (
              <AdminEmptyState title="Nenhum item cadastrado" description="Crie o primeiro item opcional da loja selecionando um evento acima." />
            ) : (
              <div className="space-y-3">
                {items.map((item) => (
                  <StoreItemCard key={item.id} contextEventId={selectedEventId} contextEventLabel={selectedEventId ? selectedEventLabel : null} item={item} canManage={canManage} />
                ))}
              </div>
            )}
          </AdminSection>

          {selectedEventId ? (
            <AdminSection title="Pedidos" description={`Compras da loja para ${selectedEventLabel}`}>
              {orders.length === 0 ? (
                <AdminEmptyState title="Nenhum pedido ainda" description="Pedidos aparecem aqui quando alguém compra um item da loja." />
              ) : (
                <StoreOrdersList orders={orders as unknown as Parameters<typeof StoreOrdersList>[0]["orders"]} canManage={canManage} canDeliver={canDeliver} />
              )}
            </AdminSection>
          ) : (
            <AdminEmptyState title="Pedidos por evento" description="Selecione um evento acima para ver os pedidos feitos na loja." />
          )}
        </div>
      </div>
    </main>
  );
}
