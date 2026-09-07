import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminEmptyState, AdminFilterBar, AdminStatusBadge } from "@/components/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { requireAnyPermission } from "@/lib/admin/permissions";
import {
  ADMIN_TICKETS_PAGE_SIZE,
  adminTicketDetailHref,
  adminTicketFiltersAreDefault,
  buildAdminTicketsHref,
  parseAdminTicketListFilters,
} from "@/lib/admin/admin-ticket-filters";
import { listAdminTickets } from "@/lib/admin/list-admin-tickets";
import { ticketSituationBadgeStatus, ticketSituationLabel } from "@/lib/tickets/ticket-situation";
import { getStatusLabel } from "@/lib/status-labels";
import { AdminTicketsFilterForm } from "./tickets-filter-form";

type Search = Record<string, string | string[] | undefined>;

export default async function TicketsAdminPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireAnyPermission(["participants.view", "orders.view"]);
  const params = await searchParams;
  const filters = parseAdminTicketListFilters(params);
  const supabase = await createServerSupabaseClient();
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) return <main className="p-8 text-slate-200">Selecione uma organização.</main>;

  const [{ data: eventsData, error: eventsError }, listed] = await Promise.all([
    supabase.from("events").select("id, name, year").eq("organization_id", organization.id).order("is_active", { ascending: false }).order("year", { ascending: false }),
    listAdminTickets(supabase, organization.id, filters),
  ]);
  if (eventsError) throw eventsError;
  if (listed.error) throw listed.error;

  const events = (eventsData ?? []).map((event) => ({
    id: String(event.id),
    label: event.year ? `${event.name} ${event.year}` : String(event.name),
  }));
  const categoryEventIds = filters.evento ? [filters.evento] : events.map((event) => event.id);
  const { data: categoriesData, error: categoriesError } = categoryEventIds.length > 0
    ? await supabase.from("ticket_categories").select("id, name, event_id, events(name)").in("event_id", categoryEventIds).order("name")
    : { data: [], error: null };
  if (categoriesError) throw categoriesError;

  const categories = ((categoriesData ?? []) as Array<{ id: string; name: string; event_id: string; events: { name: string } | { name: string }[] | null }>)
    .map((category) => {
      const event = Array.isArray(category.events) ? category.events[0] : category.events;
      const eventName = event?.name ? String(event.name) : "";
      return {
        id: String(category.id),
        label: filters.evento ? String(category.name) : `${category.name}${eventName ? ` · ${eventName}` : ""}`,
      };
    });

  const listHref = buildAdminTicketsHref(filters);
  const total = listed.total;
  const pageCount = Math.max(1, Math.ceil(total / ADMIN_TICKETS_PAGE_SIZE));
  const countLabel = total === 1 ? "1 ingresso" : `${total} ingressos`;

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl gap-6">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-6">
          <TopBar
            title={filters.userId ? "Ingressos da conta" : "Todos os ingressos"}
            subtitle="Ingressos administrativos"
          />
          <div className="flex flex-wrap gap-2">
            <Link href="/ingressos/emitir" className="inline-flex rounded-xl bg-emerald-500 px-4 py-3 font-semibold text-emerald-950">Emitir ingresso</Link>
            {filters.userId ? <Link href="/ingressos" className="inline-flex rounded-xl border border-slate-700 px-4 py-3">Ver listagem geral</Link> : null}
          </div>

          <AdminFilterBar>
            <AdminTicketsFilterForm filters={filters} events={events} categories={categories} />
          </AdminFilterBar>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-slate-300">{countLabel}</p>
            {filters.situacao === "ativos" && adminTicketFiltersAreDefault(filters) ? (
              <p className="text-xs text-slate-500">Padrão: apenas ingressos ativos. Use Situação: Todos para o histórico completo.</p>
            ) : null}
          </div>

          {listed.rows.length === 0 ? (
            <AdminEmptyState
              title="Não encontramos ingressos com esses filtros."
              description={adminTicketFiltersAreDefault(filters)
                ? "Não há ingressos ativos nesta organização agora. O histórico continua disponível em Situação: Todos."
                : "Ajuste os filtros ou limpe-os para ver outros ingressos. Nada foi excluído."}
            />
          ) : (
            <div className="space-y-2">
              {listed.rows.map((ticket) => (
                <Link
                  href={adminTicketDetailHref(ticket.ticketId, listHref)}
                  key={ticket.ticketId}
                  className="block rounded-xl border border-slate-800 p-4 transition hover:border-emerald-500/40"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{ticket.holderName}</p>
                      <p className="text-sm text-slate-400">
                        {ticket.eventName}
                        {ticket.categoryName ? ` · ${ticket.categoryName}` : " · Ingresso único"}
                        {ticket.ticketReference !== "sem número" ? ` · ${ticket.ticketReference}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <AdminStatusBadge status={ticketSituationBadgeStatus(ticket.situacao)} />
                      {ticket.status === "used" && ticket.situacao === "ativos" ? <AdminStatusBadge status="used" /> : null}
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    {ticketSituationLabel(ticket.situacao)}
                    {ticket.status === "used" ? " · Utilizado" : ticket.status === "cancelled" ? " · Cancelado" : ""}
                    {" · "}Check-in {ticket.checkinDone ? "feito" : "pendente"}
                    {ticket.kitStatus !== "none" ? ` · Kit ${ticket.kitStatus}` : ""}
                    {ticket.paymentStatus ? ` · Pagamento ${getStatusLabel(ticket.paymentStatus)}` : ""}
                    {ticket.hasOwner ? " · Com conta" : " · Sem conta"}
                    {ticket.wristbandCode ? ` · Pulseira ${ticket.wristbandCode}` : ""}
                  </p>
                </Link>
              ))}
            </div>
          )}

          {pageCount > 1 ? (
            <nav className="flex items-center justify-between" aria-label="Paginação de ingressos">
              <Link
                href={buildAdminTicketsHref(filters, { pagina: Math.max(1, filters.pagina - 1) })}
                className={`rounded-lg border border-slate-700 px-3 py-2 text-sm ${filters.pagina <= 1 ? "pointer-events-none opacity-40" : ""}`}
                aria-disabled={filters.pagina <= 1}
              >
                Anterior
              </Link>
              <span className="text-sm text-slate-400">Página {filters.pagina} de {pageCount}</span>
              <Link
                href={buildAdminTicketsHref(filters, { pagina: Math.min(pageCount, filters.pagina + 1) })}
                className={`rounded-lg border border-slate-700 px-3 py-2 text-sm ${filters.pagina >= pageCount ? "pointer-events-none opacity-40" : ""}`}
                aria-disabled={filters.pagina >= pageCount}
              >
                Próxima
              </Link>
            </nav>
          ) : null}
        </div>
      </div>
    </main>
  );
}
