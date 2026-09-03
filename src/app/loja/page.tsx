import { Sidebar } from "@/components/dashboard/Sidebar";
import { AdminEmptyState, AdminPageHeader, AdminSection } from "@/components/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentPermissionMap, requirePermission } from "@/lib/admin/permissions";
import { computeStoreItemFinalPrice } from "@/lib/store/pricing";
import { StoreEventSelector } from "./store-event-selector";
import { StoreItemForm } from "./store-item-form";
import { StoreItemCard } from "./store-item-card";
import { StoreItemStatusFilter } from "./store-item-status-filter";
import { StoreSubNav } from "./store-sub-nav";

type StatusFilter = "active" | "inactive" | "all";

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
  linkedEventKitItemVariantId: string | null;
};

type StoreItemImage = { id: string; url: string; isPrimary: boolean };

type StoreItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  primaryImageUrl: string | null;
  images: StoreItemImage[];
  price: number;
  discountType: "percentage" | "fixed" | null;
  discountValue: number;
  finalPrice: number;
  requiresVariant: boolean;
  sortOrder: number;
  supplyMode: "stock" | "made_to_order";
  visibility: "public" | "code_required" | "admin_only";
  isActive: boolean;
  eventId: string | null;
  eventLabel: string;
  linkedEventKitItemId: string | null;
  linkedEventKitItemName: string | null;
  pickupQrMode: "per_unit" | "per_line" | "none";
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

async function getStoreData(selectedEventId: string | null, statusFilter: StatusFilter) {
  const supabase = await createServerSupabaseClient();

  const { data: eventsData, error: eventsError } = await supabase
    .from("events")
    .select("id, name, year, is_active")
    .order("is_active", { ascending: false })
    .order("year", { ascending: false });
  if (eventsError) throw eventsError;
  const events = (eventsData ?? []) as EventOption[];

  // Consulta direta em store_items (nunca list_store_items_for_event) --
  // essa RPC agora so retorna itens visibility='public' (catalogo
  // self-service), e o painel admin precisa continuar enxergando TODOS os
  // itens, inclusive admin_only/code_required, pra poder gerencia-los.
  let query = supabase
    .from("store_items")
    .select(
      "id, event_id, name, slug, description, price, discount_type, discount_value, requires_variant, supply_mode, visibility, is_active, sort_order, linked_event_kit_item_id, pickup_qr_mode, event_kit_items(name, shirt_supply_mode), store_item_variants(id, name, value, price_adjustment, sort_order, is_active, linked_event_kit_item_variant_id), store_item_inventory(variant_id, total_quantity, reserved_quantity, delivered_quantity), store_item_images(id, image_url, is_primary, sort_order)"
    )
    .order("sort_order", { ascending: true });
  // "Desativado" e um estado PROPRIO (nunca sinonimo de "Indisponivel"/sem
  // estoque) -- o filtro de status controla so is_active, nunca estoque.
  query = statusFilter === "active" ? query.eq("is_active", true) : statusFilter === "inactive" ? query.eq("is_active", false) : query;
  query = selectedEventId ? query.or(`event_id.eq.${selectedEventId},event_id.is.null`) : query;
  const { data: rows, error: rowsError } = await query;
  if (rowsError) throw rowsError;

  const linkedKitItemIds = ((rows ?? []) as Array<Record<string, unknown>>)
    .map((row) => (row.linked_event_kit_item_id ? String(row.linked_event_kit_item_id) : null))
    .filter((id): id is string => Boolean(id));
  const { data: kitInvRows, error: kitInvError } = linkedKitItemIds.length
    ? await supabase.from("event_kit_item_variant_inventory").select("kit_item_id, variant_id, total_quantity, reserved_quantity, delivered_quantity").in("kit_item_id", linkedKitItemIds)
    : { data: [] as Array<Record<string, unknown>>, error: null };
  if (kitInvError) throw kitInvError;
  const kitInvByKey = new Map<string, Record<string, unknown>>();
  for (const inv of kitInvRows ?? []) kitInvByKey.set(`${inv.kit_item_id}:${inv.variant_id}`, inv);

  const items = ((rows ?? []) as Array<Record<string, unknown>>).map((row) => {
    const linkedKitItemId = row.linked_event_kit_item_id ? String(row.linked_event_kit_item_id) : null;
    const linkedKitItem = row.event_kit_items as { name?: string; shirt_supply_mode?: string } | null;
    const supplyMode = linkedKitItemId
      ? (linkedKitItem?.shirt_supply_mode === "made_to_order" ? "made_to_order" : "stock")
      : row.supply_mode === "made_to_order" ? "made_to_order" : "stock";
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
      const linkedVariantId = v.linked_event_kit_item_variant_id ? String(v.linked_event_kit_item_variant_id) : null;
      const inv = linkedKitItemId && linkedVariantId ? kitInvByKey.get(`${linkedKitItemId}:${linkedVariantId}`) : invByVariant.get(String(v.id));
      const q = availFor(inv);
      return {
        id: String(v.id), name: String(v.name ?? ""), value: String(v.value ?? ""), priceAdjustment: Number(v.price_adjustment ?? 0),
        totalQuantity: q.total, reservedQuantity: q.reserved, deliveredQuantity: q.delivered, availableQuantity: q.available,
        linkedEventKitItemVariantId: linkedVariantId,
      };
    });
    const images: StoreItemImage[] = ((Array.isArray(row.store_item_images) ? row.store_item_images : []) as Array<Record<string, unknown>>)
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .map((image) => ({ id: String(image.id), url: String(image.image_url ?? ""), isPrimary: Boolean(image.is_primary) }));
    const base = availFor(invByVariant.get(null));
    const eventId = row.event_id ? String(row.event_id) : null;
    const visibility = row.visibility === "code_required" || row.visibility === "admin_only" ? row.visibility : "public";
    const discountType = row.discount_type === "percentage" || row.discount_type === "fixed" ? row.discount_type : null;
    const discountValue = Number(row.discount_value ?? 0);
    const price = Number(row.price ?? 0);
    const pickupQrMode = row.pickup_qr_mode === "per_unit" || row.pickup_qr_mode === "none" ? row.pickup_qr_mode : "per_line";
    return {
      id: String(row.id),
      name: String(row.name ?? ""),
      slug: String(row.slug ?? ""),
      description: row.description ? String(row.description) : null,
      primaryImageUrl: images.find((image) => image.isPrimary)?.url ?? images[0]?.url ?? null,
      images,
      price,
      discountType,
      discountValue,
      finalPrice: computeStoreItemFinalPrice(price, discountType, discountValue),
      requiresVariant: Boolean(row.requires_variant),
      sortOrder: Number(row.sort_order ?? 0),
      supplyMode,
      visibility,
      isActive: Boolean(row.is_active),
      eventId,
      eventLabel: eventLabelFor(events, eventId),
      linkedEventKitItemId: linkedKitItemId,
      linkedEventKitItemName: linkedKitItem?.name ?? null,
      pickupQrMode,
      variants,
      totalQuantity: base.total, reservedQuantity: base.reserved, deliveredQuantity: base.delivered, availableQuantity: base.available,
    } satisfies StoreItem;
  }).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  return { events, selectedEventId, items };
}

export default async function LojaPage({ searchParams }: { searchParams?: Promise<{ eventId?: string; status?: string }> }) {
  await requirePermission("store.view");
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const selectedEventId = typeof resolvedSearchParams.eventId === "string" ? resolvedSearchParams.eventId : null;
  const statusFilter: StatusFilter = resolvedSearchParams.status === "inactive" || resolvedSearchParams.status === "all" ? resolvedSearchParams.status : "active";
  const { events, items } = await getStoreData(selectedEventId, statusFilter);
  const permissionMap = await getCurrentPermissionMap(["store.manage"]);
  const canManage = Boolean(permissionMap["store.manage"]);

  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? null;
  const selectedEventLabel = selectedEvent ? `${selectedEvent.name}${selectedEvent.year ? ` ${selectedEvent.year}` : ""}` : "Todos os eventos";

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader title="Loja" subtitle="Itens opcionais vendidos avulsos ou junto com o ingresso" />

          <StoreSubNav active="produtos" />

          <AdminSection title="Evento" description={`Evento selecionado: ${selectedEventLabel}`}>
            <StoreEventSelector events={events} selectedEventId={selectedEventId} />
          </AdminSection>

          <AdminSection
            title="Catálogo"
            description={selectedEventId ? `Itens opcionais disponíveis para ${selectedEventLabel}` : "Todos os itens cadastrados, de qualquer evento"}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <StoreItemStatusFilter eventId={selectedEventId} status={statusFilter} />
                {canManage ? <StoreItemForm events={events} eventId={selectedEventId} eventLabel={selectedEventLabel} item={null} /> : null}
              </div>
            }
          >
            {!selectedEventId && canManage ? (
              <p className="mb-3 text-xs text-slate-500">Um item criado aqui, sem evento selecionado, é global (disponível para todos os eventos). Selecione um evento acima para criar um item específico dele.</p>
            ) : null}
            {items.length === 0 ? (
              <AdminEmptyState title="Nenhum item cadastrado" description="Crie o primeiro item opcional da loja acima." />
            ) : (
              <div className="space-y-3">
                {items.map((item) => (
                  <StoreItemCard key={item.id} events={events} item={item} canManage={canManage} />
                ))}
              </div>
            )}
          </AdminSection>
        </div>
      </div>
    </main>
  );
}
