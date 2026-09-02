import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { AdminEmptyState } from "@/components/admin";
import { EventContextSelector } from "@/components/admin/EventContextSelector";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ShirtStockTable } from "@/components/mvp/ShirtStockTable";
import { buildShirtInventoryVariants, makeShirtInventoryKey } from "@/lib/constants/shirts";
import { getCurrentPermissionMap, hasPermission } from "@/lib/admin/permissions";

const isDevelopment = process.env.NODE_ENV !== "production";

type ShirtInventoryRow = {
  id: string;
  shirt_type: string;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
};

type EventRow = {
  id: string;
  name: string;
  year: number | null;
  is_active: boolean;
  shirt_order_deadline: string | null;
  limit_shirt_selection_to_stock: boolean;
};

type ShirtsPageData = {
  events: EventRow[];
  selectedEventId: string | null;
  selectedEvent: EventRow | null;
  rows: Array<{
    id: string;
    shirt_type: string;
    shirt_size: string;
    total_quantity: number;
    reserved_quantity: number;
    delivered_quantity: number;
    available: number;
  }>;
  errorMessage: string | null;
};

async function getStock(requestedEventId: string | null) {
  const supabase = await createServerSupabaseClient();

  const { data: eventsData, error: eventsError } = await supabase
    .from("events")
    .select("id, name, year, is_active, shirt_order_deadline, limit_shirt_selection_to_stock")
    .order("is_active", { ascending: false })
    .order("year", { ascending: false });

  if (eventsError) {
    const detailed = isDevelopment
      ? `Falha ao listar eventos: ${eventsError.message} (${eventsError.code ?? "sem-codigo"})`
      : "Não foi possível carregar os eventos.";
    return { events: [], selectedEventId: null, selectedEvent: null, rows: [], errorMessage: detailed } satisfies ShirtsPageData;
  }

  const events = (eventsData ?? []).map((event: EventRow) => ({
    id: event.id,
    name: event.name,
    year: event.year,
    is_active: Boolean(event.is_active),
    shirt_order_deadline: event.shirt_order_deadline ? String(event.shirt_order_deadline) : null,
    limit_shirt_selection_to_stock: Boolean(event.limit_shirt_selection_to_stock),
  }));

  // Mesmo padrao ja usado em /pedidos e /financeiro: eventId da URL so
  // seleciona um evento que ja esteja em `events` (RLS ja escopa a
  // organizacao do usuario) -- id invalido/inacessivel nunca "gruda", cai
  // no fallback seguro. Com exatamente 1 evento acessivel e nenhuma
  // escolha explicita, seleciona automaticamente; com 0 ou 2+, exige
  // selecao explicita via EventContextSelector.
  const explicitEvent = requestedEventId ? events.find((event) => event.id === requestedEventId) ?? null : null;
  const effectiveSelectedEvent = explicitEvent ?? (!requestedEventId && events.length === 1 ? events[0] : null);
  const effectiveSelectedEventId = effectiveSelectedEvent?.id ?? null;

  if (!effectiveSelectedEventId) {
    return {
      events,
      selectedEventId: null,
      selectedEvent: null,
      rows: [],
      errorMessage: null,
    } satisfies ShirtsPageData;
  }

  const [{ data, error }, { data: canonicalRows, error: canonicalError }] = await Promise.all([
    supabase
      .from("shirt_inventory")
      .select("id, shirt_type, shirt_size, total_quantity, reserved_quantity, delivered_quantity")
      .eq("event_id", effectiveSelectedEventId),
    supabase
      .from("event_kit_item_variant_inventory")
      .select("reserved_quantity, delivered_quantity, event_kit_item_variants(name,value)")
      .eq("event_id", effectiveSelectedEventId),
  ]);

  if (error || canonicalError) {
    const detailed = isDevelopment
      ? `Falha ao consultar estoque: ${(error ?? canonicalError)?.message} (${(error ?? canonicalError)?.code ?? "sem-codigo"})`
      : "Não foi possível carregar o estoque.";
    return { events, selectedEventId: effectiveSelectedEventId, selectedEvent: effectiveSelectedEvent, rows: [], errorMessage: detailed } satisfies ShirtsPageData;
  }

  const canonicalByVariant = new Map<string, { reserved: number; delivered: number }>();
  for (const row of (canonicalRows ?? []) as Array<Record<string, unknown>>) {
    const relation = Array.isArray(row.event_kit_item_variants)
      ? row.event_kit_item_variants[0]
      : row.event_kit_item_variants;
    if (!relation || typeof relation !== "object") continue;
    const variant = relation as Record<string, unknown>;
    canonicalByVariant.set(makeShirtInventoryKey(String(variant.name ?? ""), String(variant.value ?? "")), {
      reserved: Number(row.reserved_quantity ?? 0),
      delivered: Number(row.delivered_quantity ?? 0),
    });
  }

  const rows = buildShirtInventoryVariants((data ?? []) as ShirtInventoryRow[]).map((row) => {
    const canonical = canonicalByVariant.get(makeShirtInventoryKey(row.shirt_type, row.shirt_size));
    const reserved = canonical?.reserved ?? row.reserved_quantity;
    const delivered = canonical?.delivered ?? row.delivered_quantity;
    return {
      id: row.id,
      shirt_type: row.shirt_type,
      shirt_size: row.shirt_size,
      total_quantity: row.total_quantity,
      reserved_quantity: reserved,
      delivered_quantity: delivered,
      available: Math.max(row.total_quantity - delivered, 0),
    };
  });

  return {
    events,
    selectedEventId: effectiveSelectedEventId,
    selectedEvent: effectiveSelectedEvent,
    rows,
    errorMessage: null,
  } satisfies ShirtsPageData;
}

export default async function ShirtsPage({ searchParams }: { searchParams?: Promise<{ eventId?: string }> }) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const selectedEventId = typeof resolvedSearchParams.eventId === "string" ? resolvedSearchParams.eventId : null;
  const { events, selectedEventId: resolvedEventId, selectedEvent, rows, errorMessage } = await getStock(selectedEventId);
  const permissionMap = await getCurrentPermissionMap([
    "inventory.adjust",
    "inventory.view_history",
    "inventory.limit_selection",
    "inventory.reset",
    "inventory.clear_history",
  ]);
  const canCreateEvent = await hasPermission("events.create");

  const selectedEventLabel = selectedEvent
    ? `${selectedEvent.name}${selectedEvent.year ? ` ${selectedEvent.year}` : ""}`
    : "Selecione um evento";
  const eventOptions = events.map((event) => ({
    id: event.id,
    name: `${event.name}${event.year ? ` ${event.year}` : ""}`,
    is_active: event.is_active,
  }));

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow-strong),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Camisetas" subtitle="Controle de estoque por modelo e tamanho" />
          <SectionCard title="Estoque real" description="Gerencie encomendas e ajustes sem duplicar combinações de modelo e tamanho.">
            {eventOptions.length === 0 ? (
              <AdminEmptyState
                title="Nenhum evento disponível"
                description="Crie um evento para começar a gerenciar o estoque de camisetas."
                action={
                  canCreateEvent ? (
                    <Link
                      href="/painel/eventos"
                      className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300 hover:bg-emerald-500/20 transition"
                    >
                      Criar evento
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
                <p className="font-semibold text-slate-100">Estoque do evento: {selectedEventLabel}</p>
                <EventContextSelector events={eventOptions} selectedEventId={resolvedEventId} pathname="/camisetas" />
              </div>
            )}
            {errorMessage ? (
              <div className="mb-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{errorMessage}</div>
            ) : null}
            {resolvedEventId ? (
              <ShirtStockTable
                rows={rows}
                eventId={resolvedEventId}
                eventName={selectedEventLabel}
                shirtOrderDeadline={selectedEvent?.shirt_order_deadline ?? null}
                limitShirtSelectionToStock={Boolean(selectedEvent?.limit_shirt_selection_to_stock)}
                canAdjustInventory={Boolean(permissionMap["inventory.adjust"])}
                canViewHistory={Boolean(permissionMap["inventory.view_history"])}
                canLimitSelection={Boolean(permissionMap["inventory.limit_selection"])}
                canResetInventory={Boolean(permissionMap["inventory.reset"])}
                canClearHistory={Boolean(permissionMap["inventory.clear_history"])}
              />
            ) : null}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
