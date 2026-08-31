import { Sidebar } from "@/components/dashboard/Sidebar";
import { AdminEmptyState, AdminFilterBar, AdminPageHeader, AdminSection } from "@/components/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireAnyPermission } from "@/lib/admin/permissions";
import { resolveOperatorNames } from "@/lib/admin/operator-names";
import { StoreSubNav } from "../store-sub-nav";
import { OperationalProductItemCard } from "./operational-product-item-card";
import type { OperationalProductItem } from "@/lib/operations/operational-product-item";
import { orderDisplayReference } from "@/lib/display-reference";
import Link from "next/link";

type SearchParams = Promise<{
  status?: string;
  eventId?: string;
  global?: string;
  q?: string;
  dateFrom?: string;
  dateTo?: string;
}>;

const STATUS_TABS = [
  ["all", "Todos"],
  ["pending", "Pendentes"],
  ["confirmed", "Pagos/Confirmados"],
  ["to_deliver", "A entregar"],
  ["delivered", "Entregues"],
  ["cancelled", "Cancelados"],
] as const;

function toDateOnly(value: string | undefined, endOfDay: boolean) {
  if (!value) return null;
  const iso = `${value}T${endOfDay ? "23:59:59" : "00:00:00"}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

type RawOperationalProductItemRow = {
  source: "store" | "checkout";
  item_id: string;
  order_id: string;
  order_number: string;
  display_number: number | null;
  product_name: string;
  variant: string | null;
  quantity: number;
  event_id: string | null;
  event_name: string;
  buyer: string;
  payment_status: string;
  delivery_status: OperationalProductItem["delivery_status"];
  delivered_at: string | null;
  delivered_by_user_id: string | null;
  created_at: string;
};

export default async function StoreOrdersPage({ searchParams }: { searchParams: SearchParams }) {
  await requireAnyPermission(["store.view", "store.deliver"]);

  const params = await searchParams;
  const status = STATUS_TABS.some(([code]) => code === params.status) ? (params.status as string) : "all";
  const globalOnly = params.global === "1";
  const eventId = !globalOnly && params.eventId ? params.eventId : "";
  const q = params.q ?? "";
  const dateFrom = params.dateFrom ?? "";
  const dateTo = params.dateTo ?? "";

  const supabase = await createServerSupabaseClient();
  const friendlySearch = q.trim().match(/^#?(\d{1,12})$/);
  const [{ data: eventsData, error: eventsError }, { data: itemRows, error: itemsError }] = await Promise.all([
    supabase.from("events").select("id, name, year").order("is_active", { ascending: false }).order("year", { ascending: false }),
    // Consolida os dois canais de venda de produto (loja standalone e
    // "compre junto" no checkout de ingresso) numa unica leitura -- nenhuma
    // tabela nova, nenhum dado duplicado, so UNION ALL em list_operational_
    // product_items (20260918000000). 1 linha por ITEM, nunca por pedido.
    supabase.rpc("list_operational_product_items", {
      p_status: status === "all" ? null : status,
      p_event_id: eventId || null,
      p_search: friendlySearch ? null : q.trim() || null,
      p_date_from: toDateOnly(dateFrom, false),
      p_date_to: toDateOnly(dateTo, true),
    }),
  ]);
  if (eventsError) throw eventsError;
  if (itemsError) throw itemsError;

  const events = (eventsData ?? []).map((event: Record<string, unknown>) => ({ id: String(event.id), name: String(event.name), year: event.year as number | null }));
  const rawItems = (itemRows ?? []) as RawOperationalProductItemRow[];

  // delivered_by so existe em audit_logs como user_id -- resolvido em lote
  // aqui (reusa o unico resolvedor canonico de "nome a partir de user_id"
  // pra acoes administrativas, o mesmo usado pelos resolvers de QR do
  // Turbo/Central), nunca inventado a partir do usuario atual.
  const deliveredByIds = [...new Set(rawItems.map((row) => row.delivered_by_user_id).filter((id): id is string => Boolean(id)))];
  const operatorNames = await resolveOperatorNames(deliveredByIds);

  const items: OperationalProductItem[] = rawItems.map((row) => ({
    source: row.source,
    item_id: row.item_id,
    order_id: row.order_id,
    order_reference: orderDisplayReference(row.display_number, row.order_number),
    product_name: row.product_name,
    variant: row.variant,
    quantity: row.quantity,
    event_id: row.event_id,
    event_name: row.event_name,
    buyer: row.buyer,
    payment_status: row.payment_status,
    delivery_status: row.delivery_status,
    delivered_at: row.delivered_at,
    delivered_by: row.delivered_by_user_id ? operatorNames.get(row.delivered_by_user_id) ?? "Operador administrativo" : null,
  }));

  const orders = items
    .filter((item) => !friendlySearch || item.order_reference === `#${friendlySearch[1].padStart(6, "0")}`)
    .filter((item) => !globalOnly || (item.source === "store" && !item.event_id));

  function statusHref(code: string) {
    const qs = new URLSearchParams();
    qs.set("status", code);
    if (globalOnly) qs.set("global", "1");
    else if (eventId) qs.set("eventId", eventId);
    if (q) qs.set("q", q);
    if (dateFrom) qs.set("dateFrom", dateFrom);
    if (dateTo) qs.set("dateTo", dateTo);
    return `/loja/pedidos?${qs.toString()}`;
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader title="Loja" subtitle="Produtos vendidos na loja e no checkout de ingresso (compre junto) -- visao unica de entrega" />

          <StoreSubNav active="pedidos" />

          <nav className="flex flex-wrap gap-2" aria-label="Status do pedido">
            {STATUS_TABS.map(([code, label]) => (
              <Link
                key={code}
                href={statusHref(code)}
                className={`rounded-xl border px-3 py-1.5 text-xs ${status === code ? "border-emerald-400 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-300"}`}
              >
                {label}
              </Link>
            ))}
          </nav>

          <AdminFilterBar>
            <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_200px_140px_140px_auto]" action="/loja/pedidos">
              <input type="hidden" name="status" value={status} />
              <input
                type="text"
                name="q"
                defaultValue={q}
                placeholder="Buscar por nome, e-mail ou número do pedido"
                className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
              />
              <select name="eventId" defaultValue={globalOnly ? "" : eventId} className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100">
                <option value="">Todos os eventos</option>
                {events.map((event) => (
                  <option key={event.id} value={event.id}>{event.name}{event.year ? ` ${event.year}` : ""}</option>
                ))}
              </select>
              <input type="date" name="dateFrom" defaultValue={dateFrom} className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100" />
              <input type="date" name="dateTo" defaultValue={dateTo} className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100" />
              <button type="submit" className="h-10 rounded-xl bg-emerald-400 px-4 text-xs font-semibold text-slate-950">Aplicar</button>

              <label className="flex items-center gap-2 text-xs text-slate-300 md:col-span-2 xl:col-span-5">
                <input type="checkbox" name="global" value="1" defaultChecked={globalOnly} className="h-4 w-4 accent-emerald-500" />
                Mostrar somente produtos globais (sem evento)
              </label>
            </form>
          </AdminFilterBar>

          <AdminSection title="Produtos" description={`${orders.length} item(ns) encontrado(s)`}>
            {orders.length === 0 ? (
              <AdminEmptyState title="Nenhum item encontrado" description="Ajuste os filtros ou aguarde novas compras." />
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {orders.map((item) => (
                  <OperationalProductItemCard key={`${item.source}:${item.item_id}`} item={item} />
                ))}
              </div>
            )}
          </AdminSection>
        </div>
      </div>
    </main>
  );
}
