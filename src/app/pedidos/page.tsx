import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminEmptyState, AdminFilterBar, AdminPageHeader, AdminSection, AdminStatusBadge } from "@/components/admin";
import { EventContextSelector } from "@/components/admin/EventContextSelector";
import { formatDateTimeBR } from "@/lib/utils/date";
import { hasPermission } from "@/lib/admin/permissions";
import { listOrdersAction } from "./actions";

type SearchParams = {
  eventId?: string;
  paymentStatus?: string;
  orderStatus?: string;
  q?: string;
  page?: string;
};

const paymentStatusLabel: Record<string, string> = {
  pending: "Pendente", paid: "Pago", expired: "Expirado",
  cancelled: "Cancelado", refunded: "Estornado",
};

const orderStatusLabel: Record<string, string> = {
  pending: "Pendente", confirmed: "Confirmado", expired: "Expirado",
  cancelled: "Cancelado", refunded: "Estornado",
};

const paymentMethodLabel: Record<string, string> = {
  pix: "PIX", credit_card: "Cartão", cash: "Dinheiro", courtesy: "Cortesia",
};

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export default async function PedidosPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const [{ events, selectedEvent, rows, page, totalPages, totalFiltered, canViewAmounts }, canCreateEvent] =
    await Promise.all([listOrdersAction(params), hasPermission("events.create")]);

  const buildUrl = (overrides: Partial<SearchParams>) => {
    const next = { ...params, ...overrides };
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== "")),
    ).toString();
    return `/pedidos${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar title="Pedidos" subtitle="Gestão de compras e ingressos" />

        <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-6">
          <AdminPageHeader
            title="Pedidos"
            subtitle={selectedEvent ? `Evento: ${selectedEvent.name}` : events.length ? "Selecione um evento" : "Nenhum evento disponível"}
          />

          {/* Nenhum evento na organizacao: nunca mostra "Nenhum evento
              selecionado" sem oferecer forma de resolver -- estado vazio
              coerente, com CTA so pra quem pode criar evento. */}
          {!events.length ? (
            <AdminEmptyState
              title="Nenhum evento disponível"
              description="Crie um evento para começar a gerenciar pedidos."
              action={canCreateEvent ? <Link href="/painel/eventos" className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300 hover:bg-emerald-500/20 transition">Criar evento</Link> : undefined}
            />
          ) : (
            // Mesmo componente ja usado por /categorias, /lotes e /financeiro
            // (nunca um segundo seletor de evento so pra Pedidos). Com
            // exatamente 1 evento, listOrdersAction ja auto-seleciona --
            // aqui so reflete o estado, sem exigir clique extra.
            <EventContextSelector events={events} selectedEventId={selectedEvent?.id ?? null} pathname="/pedidos" />
          )}

          {/* Filtros */}
          <AdminFilterBar>
            <form method="GET" className="flex flex-wrap gap-3">
              {selectedEvent && (
                <input type="hidden" name="eventId" value={selectedEvent.id} />
              )}
              <input
                name="q"
                defaultValue={params.q ?? ""}
                placeholder="Nome, CPF ou nº do pedido"
                className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none w-64"
              />
              <select
                name="paymentStatus"
                defaultValue={params.paymentStatus ?? ""}
                className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="">Pagamento — todos</option>
                {Object.entries(paymentStatusLabel).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <select
                name="orderStatus"
                defaultValue={params.orderStatus ?? ""}
                className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none"
              >
                <option value="">Status — todos</option>
                {Object.entries(orderStatusLabel).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <button
                type="submit"
                className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300 hover:bg-emerald-500/20 transition"
              >
                Filtrar
              </button>
              {(params.q || params.paymentStatus || params.orderStatus) && (
                <Link
                  href={buildUrl({ q: "", paymentStatus: "", orderStatus: "", page: "1" })}
                  className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-400 hover:text-slate-200 transition"
                >
                  Limpar
                </Link>
              )}
            </form>
          </AdminFilterBar>

          <AdminSection title={`${totalFiltered} pedido${totalFiltered !== 1 ? "s" : ""}`}>
            {rows.length === 0 ? (
              <AdminEmptyState
                title="Nenhum pedido encontrado"
                description="Tente ajustar os filtros ou selecionar outro evento."
              />
            ) : (
              <div className="space-y-2">
                {rows.map((order) => (
                  <details
                    key={order.id}
                    className="group rounded-2xl border border-slate-800/80 bg-slate-900/60 open:border-emerald-500/20"
                  >
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-5 py-4 hover:bg-slate-800/30 transition rounded-2xl">
                      {/* Número do pedido */}
                      <span className="text-xs font-semibold text-slate-300 w-28 shrink-0">
                        Pedido {order.orderNumber}
                      </span>

                      {/* Comprador */}
                      <span className="flex-1 min-w-[160px]">
                        <span className="block text-sm font-medium text-slate-100">{order.buyerName}</span>
                        <span className="block text-xs text-slate-400">{order.buyerEmail}</span>
                      </span>

                      {/* Data */}
                      <span className="text-xs text-slate-400 w-36 shrink-0 hidden sm:block">
                        {formatDateTimeBR(order.createdAt)}
                      </span>

                      {/* Ingressos */}
                      <span className="text-xs text-slate-300 w-20 shrink-0 text-center">
                        {order.ticketCount} {order.ticketCount === 1 ? "ingresso" : "ingressos"}
                      </span>

                      {/* Método */}
                      <span className="text-xs text-slate-400 w-20 shrink-0 hidden md:block">
                        {order.paymentMethod ? paymentMethodLabel[order.paymentMethod] ?? order.paymentMethod : "—"}
                      </span>

                      {/* Pagamento */}
                      <span className="w-24 shrink-0">
                        <AdminStatusBadge
                          status={order.paymentStatus}
                        />
                      </span>

                      {/* Valor total */}
                      {canViewAmounts && (
                        <span className="text-sm font-medium text-slate-100 w-24 text-right shrink-0">
                          {money(order.finalAmount)}
                          {order.hasDiscount && (
                            <span className="ml-1 text-xs text-emerald-400">
                              -{money(order.discountAmount)}
                            </span>
                          )}
                        </span>
                      )}

                      {/* Chevron */}
                      <span className="ml-auto text-slate-500 group-open:rotate-90 transition-transform">›</span>
                    </summary>

                    {/* Ingressos expandidos */}
                    <div className="border-t border-slate-800/60 px-5 pb-4 pt-3">
                      {order.items.length === 0 ? (
                        <p className="text-xs text-slate-500">Nenhum ingresso encontrado para este pedido.</p>
                      ) : (
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-slate-500 border-b border-slate-800/60">
                              <th className="py-1.5 pr-4 text-left font-medium">#</th>
                              <th className="py-1.5 pr-4 text-left font-medium">Titular</th>
                              <th className="py-1.5 pr-4 text-left font-medium">Categoria</th>
                              <th className="py-1.5 pr-4 text-left font-medium">Status ingresso</th>
                              <th className="py-1.5 text-left font-medium">Vínculo</th>
                            </tr>
                          </thead>
                          <tbody>
                            {order.items.map((item) => (
                              <tr key={item.id} className="border-b border-slate-800/30 last:border-0">
                                <td className="py-2 pr-4 text-slate-400">{item.itemPosition}</td>
                                <td className="py-2 pr-4 text-slate-200">
                                  {item.holderName ?? <span className="text-slate-500 italic">Não atribuído</span>}
                                </td>
                                <td className="py-2 pr-4 text-slate-300">
                                  {item.categoryName ?? "—"}
                                </td>
                                <td className="py-2 pr-4">
                                  {item.ticketStatus ? (
                                    <AdminStatusBadge status={item.ticketStatus} />
                                  ) : (
                                    <span className="text-slate-500">—</span>
                                  )}
                                </td>
                                <td className="py-2 text-slate-400">{item.ownershipStatus}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {order.productItems.length > 0 && (
                        <div className="mt-3 border-t border-slate-800/60 pt-3">
                          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                            Itens / produtos ({order.productItems.length})
                          </p>
                          <ul className="space-y-1.5">
                            {order.productItems.map((product) => (
                              <li key={product.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <span className="text-slate-300">
                                  {product.quantity}x {product.productName ?? "Produto"}
                                  {product.variant ? ` · ${product.variant}` : ""}
                                </span>
                                <span className="text-slate-500">{product.status}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="mt-3 flex gap-3">
                        <Link
                          href={`/inscricoes/${order.id}`}
                          className="text-xs text-slate-400 underline hover:text-slate-200"
                        >
                          Abrir ficha →
                        </Link>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </AdminSection>

          {/* Paginação */}
          {totalPages > 1 && (
            <div className="flex gap-2 justify-center">
              {page > 1 && (
                <Link
                  href={buildUrl({ page: String(page - 1) })}
                  className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-slate-500 transition"
                >
                  ← Anterior
                </Link>
              )}
              <span className="rounded-xl border border-slate-800 px-4 py-2 text-sm text-slate-400">
                {page} / {totalPages}
              </span>
              {page < totalPages && (
                <Link
                  href={buildUrl({ page: String(page + 1) })}
                  className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-slate-500 transition"
                >
                  Próxima →
                </Link>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
