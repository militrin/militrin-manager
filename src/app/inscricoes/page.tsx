import Link from 'next/link';
import { Sidebar } from '@/components/dashboard/Sidebar';
import {
  AdminDataTable,
  AdminEmptyState,
  AdminFilterBar,
  AdminPageHeader,
  AdminSection,
  AdminStatusBadge,
  maskCpf,
} from '@/components/admin';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { confirmParticipantPaymentAction, releaseExpiredReservationsAction, resendParticipantTicketAction } from './actions';

type Params = {
  page?: string;
  eventId?: string;
  q?: string;
  cpf?: string;
  email?: string;
  phone?: string;
  city?: string;
  category?: string;
  batch?: string;
  paymentStatus?: string;
  orderStatus?: string;
  shirtType?: string;
  shirtSize?: string;
  kitDelivered?: string;
  checkin?: string;
};

const PAGE_SIZE = 20;

function stringContains(value: unknown, term: string) {
  return String(value ?? '').toLowerCase().includes(term.toLowerCase());
}

function normalizeStatus(value: unknown) {
  const status = String(value ?? 'pending').toLowerCase();
  if (status === 'paid') return 'confirmed';
  return status;
}

async function getListData(params: Params) {
  await releaseExpiredReservationsAction();

  const supabase = await createServerSupabaseClient();

  const { data: eventsData } = await supabase
    .from('events')
    .select('id, name, is_active')
    .order('is_active', { ascending: false })
    .order('starts_at', { ascending: false, nullsFirst: false });

  const events = (eventsData ?? []).map((event) => ({ id: String(event.id), name: String(event.name), is_active: Boolean(event.is_active) }));
  const selectedEvent = (params.eventId && events.find((item) => item.id === params.eventId)) ?? events.find((item) => item.is_active) ?? events[0] ?? null;

  if (!selectedEvent) {
    return { events, selectedEvent: null, rows: [], page: 1, totalPages: 1, totalFiltered: 0 };
  }

  const { data, error } = await supabase
    .from('participants')
    .select('id, full_name, cpf, email, phone, city, shirt_type, shirt_size, registration_status, payment_status, created_at, notes, ticket_categories(name), registration_batches(name), payments(id, payment_status, payment_method, created_at), orders(id, order_number, status), tickets(id, status, token, used_at)')
    .eq('event_id', selectedEvent.id)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw error;

  const participantIds = (data ?? []).map((item) => String(item.id));
  const kitMap = new Map<string, { total: number; delivered: number }>();
  if (participantIds.length > 0) {
    const { data: kitRows } = await supabase
      .from('participant_kit_items')
      .select('participant_id, status')
      .in('participant_id', participantIds);

    for (const row of kitRows ?? []) {
      const key = String(row.participant_id ?? '');
      if (!key) continue;
      const prev = kitMap.get(key) ?? { total: 0, delivered: 0 };
      const delivered = String(row.status ?? '') === 'delivered' ? 1 : 0;
      kitMap.set(key, { total: prev.total + 1, delivered: prev.delivered + delivered });
    }
  }

  const allRows = (data ?? []).map((item) => {
    const payment = Array.isArray(item.payments)
      ? item.payments.slice().sort((a, b) => new Date(String(b.created_at ?? 0)).getTime() - new Date(String(a.created_at ?? 0)).getTime())[0]
      : item.payments;
    const order = Array.isArray(item.orders) ? item.orders[0] : item.orders;
    const ticket = Array.isArray(item.tickets) ? item.tickets[0] : item.tickets;
    const category = Array.isArray(item.ticket_categories) ? item.ticket_categories[0] : item.ticket_categories;
    const batch = Array.isArray(item.registration_batches) ? item.registration_batches[0] : item.registration_batches;
    const kit = kitMap.get(String(item.id)) ?? { total: 0, delivered: 0 };
    const allDelivered = kit.total > 0 && kit.delivered === kit.total;

    return {
      id: String(item.id),
      fullName: String(item.full_name ?? ''),
      cpf: String(item.cpf ?? ''),
      email: String(item.email ?? ''),
      phone: String(item.phone ?? ''),
      city: String(item.city ?? ''),
      category: category?.name ? String(category.name) : 'Sem categoria',
      batch: batch?.name ? String(batch.name) : 'Sem lote',
      shirtType: String(item.shirt_type ?? ''),
      shirtSize: String(item.shirt_size ?? ''),
      paymentStatus: normalizeStatus(payment?.payment_status ?? item.payment_status),
      orderStatus: normalizeStatus(order?.status ?? item.registration_status),
      orderId: order?.id ? String(order.id) : null,
      ticketId: ticket?.id ? String(ticket.id) : null,
      ticketStatus: normalizeStatus(ticket?.status ?? 'pending'),
      ticketToken: ticket?.token ? String(ticket.token) : null,
      checkinDone: String(ticket?.status ?? '') === 'used',
      kitDelivered: allDelivered,
      createdAt: String(item.created_at ?? ''),
    };
  });

  const filtered = allRows.filter((row) => {
    if (params.q && !(stringContains(row.fullName, params.q) || stringContains(row.cpf, params.q) || stringContains(row.phone, params.q))) return false;
    if (params.cpf && !stringContains(row.cpf, params.cpf)) return false;
    if (params.email && !stringContains(row.email, params.email)) return false;
    if (params.phone && !stringContains(row.phone, params.phone)) return false;
    if (params.city && !stringContains(row.city, params.city)) return false;
    if (params.category && !stringContains(row.category, params.category)) return false;
    if (params.batch && !stringContains(row.batch, params.batch)) return false;
    if (params.shirtType && !stringContains(row.shirtType, params.shirtType)) return false;
    if (params.shirtSize && !stringContains(row.shirtSize, params.shirtSize)) return false;
    if (params.paymentStatus && params.paymentStatus !== 'all' && row.paymentStatus !== params.paymentStatus) return false;
    if (params.orderStatus && params.orderStatus !== 'all' && row.orderStatus !== params.orderStatus) return false;
    if (params.kitDelivered === 'yes' && !row.kitDelivered) return false;
    if (params.kitDelivered === 'no' && row.kitDelivered) return false;
    if (params.checkin === 'yes' && !row.checkinDone) return false;
    if (params.checkin === 'no' && row.checkinDone) return false;
    return true;
  });

  const page = Math.max(1, Number(params.page ?? 1));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * PAGE_SIZE;

  return {
    events,
    selectedEvent,
    rows: filtered.slice(start, start + PAGE_SIZE),
    page: safePage,
    totalPages,
    totalFiltered: filtered.length,
  };
}

function Pagination({ page, totalPages, query }: { page: number; totalPages: number; query: URLSearchParams }) {
  const prev = new URLSearchParams(query.toString());
  prev.set('page', String(Math.max(1, page - 1)));
  const next = new URLSearchParams(query.toString());
  next.set('page', String(Math.min(totalPages, page + 1)));

  return (
    <div className="flex items-center justify-between gap-2 text-sm text-slate-300">
      <p>Página {page} de {totalPages}</p>
      <div className="flex gap-2">
        <a href={`/inscricoes?${prev.toString()}`} className="rounded-lg border border-slate-700 px-3 py-1.5">Anterior</a>
        <a href={`/inscricoes?${next.toString()}`} className="rounded-lg border border-slate-700 px-3 py-1.5">Próxima</a>
      </div>
    </div>
  );
}

export default async function ParticipantsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const data = await getListData(params);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader title="Participantes" subtitle="Lista avançada com filtros operacionais e ações rápidas" />

          {!data.selectedEvent ? (
            <AdminEmptyState title="Sem evento ativo" description="Cadastre ou ative um evento para visualizar participantes." />
          ) : (
            <AdminSection title="Busca e filtros" description={`Evento: ${data.selectedEvent.name}`}>
              <AdminFilterBar>
                <form action="/inscricoes" className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
                  <input type="hidden" name="eventId" value={data.selectedEvent.id} />
                  <input name="q" defaultValue={params.q ?? ''} placeholder="Nome, CPF ou telefone" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
                  <input name="email" defaultValue={params.email ?? ''} placeholder="E-mail" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
                  <input name="city" defaultValue={params.city ?? ''} placeholder="Cidade" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
                  <input name="category" defaultValue={params.category ?? ''} placeholder="Categoria" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
                  <input name="batch" defaultValue={params.batch ?? ''} placeholder="Lote" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
                  <input name="shirtType" defaultValue={params.shirtType ?? ''} placeholder="Tipo camiseta" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />
                  <input name="shirtSize" defaultValue={params.shirtSize ?? ''} placeholder="Tamanho" className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" />

                  <select name="paymentStatus" defaultValue={params.paymentStatus ?? 'all'} className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm">
                    <option value="all">Pagamento: todos</option>
                    <option value="pending">Pendente</option>
                    <option value="confirmed">Confirmado</option>
                    <option value="cancelled">Cancelado</option>
                  </select>

                  <select name="orderStatus" defaultValue={params.orderStatus ?? 'all'} className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm">
                    <option value="all">Pedido: todos</option>
                    <option value="pending">Pendente</option>
                    <option value="confirmed">Confirmado</option>
                    <option value="cancelled">Cancelado</option>
                    <option value="expired">Expirado</option>
                  </select>

                  <select name="kitDelivered" defaultValue={params.kitDelivered ?? 'all'} className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm">
                    <option value="all">Kit: todos</option>
                    <option value="yes">Entregue</option>
                    <option value="no">Pendente</option>
                  </select>

                  <select name="checkin" defaultValue={params.checkin ?? 'all'} className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm">
                    <option value="all">Check-in: todos</option>
                    <option value="yes">Realizado</option>
                    <option value="no">Não realizado</option>
                  </select>

                  <div className="xl:col-span-4 flex flex-wrap gap-2">
                    <button type="submit" className="h-10 rounded-lg bg-emerald-400 px-4 text-sm font-semibold text-slate-950">Aplicar filtros</button>
                    <a href={`/inscricoes?eventId=${data.selectedEvent.id}`} className="inline-flex h-10 items-center rounded-lg border border-slate-700 px-4 text-sm">Limpar</a>
                    <Link href="/inscricoes/nova" className="inline-flex h-10 items-center rounded-lg border border-slate-700 px-4 text-sm">Nova inscrição</Link>
                  </div>
                </form>
              </AdminFilterBar>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-300">
                <p>{data.totalFiltered} participante(s) encontrado(s)</p>
                <form action="/inscricoes" className="flex items-center gap-2">
                  <label htmlFor="eventId" className="text-xs uppercase tracking-[0.15em] text-slate-400">Evento</label>
                  <select id="eventId" name="eventId" defaultValue={data.selectedEvent.id} className="h-9 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm">
                    {data.events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
                  </select>
                  <button type="submit" className="h-9 rounded-lg border border-slate-700 px-3 text-xs">Trocar</button>
                </form>
              </div>

              {data.rows.length === 0 ? (
                <div className="mt-4">
                  <AdminEmptyState title="Nenhum participante encontrado" description="Ajuste os filtros ou crie uma nova inscrição." />
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  <AdminDataTable>
                    <thead className="bg-slate-950/70 text-left text-slate-400">
                      <tr>
                        <th className="px-3 py-3 font-medium">Nome</th>
                        <th className="px-3 py-3 font-medium">CPF</th>
                        <th className="px-3 py-3 font-medium">Cidade</th>
                        <th className="px-3 py-3 font-medium">Categoria</th>
                        <th className="px-3 py-3 font-medium">Camiseta</th>
                        <th className="px-3 py-3 font-medium">Pagamento</th>
                        <th className="px-3 py-3 font-medium">Ingresso</th>
                        <th className="px-3 py-3 font-medium">Kit</th>
                        <th className="px-3 py-3 font-medium">Check-in</th>
                        <th className="px-3 py-3 font-medium">Ações</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 bg-slate-900/60 text-slate-200">
                      {data.rows.map((row) => (
                        <tr key={row.id}>
                          <td className="px-3 py-3">{row.fullName}</td>
                          <td className="px-3 py-3">{maskCpf(row.cpf)}</td>
                          <td className="px-3 py-3">{row.city || '-'}</td>
                          <td className="px-3 py-3">{row.category}</td>
                          <td className="px-3 py-3">{row.shirtType} {row.shirtSize}</td>
                          <td className="px-3 py-3"><AdminStatusBadge status={row.paymentStatus} /></td>
                          <td className="px-3 py-3"><AdminStatusBadge status={row.ticketStatus} /></td>
                          <td className="px-3 py-3"><AdminStatusBadge status={row.kitDelivered ? 'delivered' : 'pending'} /></td>
                          <td className="px-3 py-3"><AdminStatusBadge status={row.checkinDone ? 'used' : 'pending'} /></td>
                          <td className="px-3 py-3">
                            <div className="flex flex-wrap gap-2">
                              <Link href={`/inscricoes/${row.id}`} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs">Abrir ficha</Link>
                              <Link href={`/inscricoes/${row.id}/editar`} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs">Editar</Link>
                              <Link href={`/inscricoes/${row.id}/editar`} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs">Alterar camiseta</Link>

                              {row.paymentStatus === 'pending' ? (
                                <form action={async () => { 'use server'; await confirmParticipantPaymentAction(row.id); }}>
                                  <button type="submit" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200">Confirmar pagamento</button>
                                </form>
                              ) : null}

                              {row.orderStatus === 'confirmed' ? (
                                <form action={async () => { 'use server'; await resendParticipantTicketAction(row.id); }}>
                                  <button type="submit" className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-200">Reenviar ingresso</button>
                                </form>
                              ) : null}

                              {row.ticketId ? (
                                <Link href={`/minha-conta/ingressos/${row.ticketId}`} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs">Ver QR</Link>
                              ) : null}
                              <Link href={`/inscricoes/${row.id}#historico`} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs">Histórico</Link>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </AdminDataTable>

                  <Pagination page={data.page} totalPages={data.totalPages} query={query} />
                </div>
              )}
            </AdminSection>
          )}
        </div>
      </div>
    </main>
  );
}
