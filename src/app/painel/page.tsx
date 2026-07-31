import Link from 'next/link';
import { Sidebar } from '@/components/dashboard/Sidebar';
import {
  AdminEmptyState,
  AdminPageHeader,
  AdminSection,
  AdminStatCard,
  AdminStatusBadge,
} from '@/components/admin';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminAccessContext } from '@/lib/admin/access';

type EventOption = { id: string; name: string; is_active: boolean };

type ChartRow = { label: string; value: number };

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function groupCount(values: Array<string | null | undefined>, fallback = 'Nao informado') {
  const map = new Map<string, number>();
  for (const value of values) {
    const key = String(value ?? '').trim() || fallback;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function groupSum(entries: Array<{ label: string; value: number }>) {
  const map = new Map<string, number>();
  for (const entry of entries) {
    map.set(entry.label, (map.get(entry.label) ?? 0) + entry.value);
  }
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function BarChart({ rows, emptyLabel }: { rows: ChartRow[]; emptyLabel: string }) {
  if (!rows.length) return <p className="text-sm text-slate-400">{emptyLabel}</p>;

  const maxValue = Math.max(...rows.map((item) => item.value), 1);

  return (
    <div className="space-y-2">
      {rows.map((item) => (
        <div key={item.label} className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs text-slate-300">
            <span className="truncate">{item.label}</span>
            <span>{item.value}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-emerald-400" style={{ width: `${(item.value / maxValue) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

async function getDashboardData(eventId?: string) {
  const supabase = await createServerSupabaseClient();

  const { data: eventsData, error: eventsError } = await supabase
    .from('events')
    .select('id, name, is_active')
    .order('is_active', { ascending: false })
    .order('starts_at', { ascending: false, nullsFirst: false });
  if (eventsError) throw eventsError;

  const events: EventOption[] = (eventsData ?? []).map((event) => ({
    id: String(event.id),
    name: String(event.name),
    is_active: Boolean(event.is_active),
  }));

  const selectedEvent = (eventId && events.find((item) => item.id === eventId)) ?? events.find((item) => item.is_active) ?? events[0] ?? null;
  if (!selectedEvent) {
    return {
      events,
      selectedEvent: null,
      participants: [] as Array<Record<string, unknown>>,
      payments: [] as Array<Record<string, unknown>>,
      tickets: [] as Array<Record<string, unknown>>,
      inventory: [] as Array<Record<string, unknown>>,
      kitRows: [] as Array<Record<string, unknown>>,
    };
  }

  const [{ data: participants, error: participantsError }, { data: payments, error: paymentsError }, { data: tickets, error: ticketsError }, { data: inventory, error: inventoryError }, { data: kitRows, error: kitError }] = await Promise.all([
    supabase
      .from('participants')
      .select('id, full_name, city, gender, created_at, final_amount, registration_status, shirt_type, shirt_size, batch_id, registration_batches(name), ticket_categories(name), reservation_status')
      .eq('event_id', selectedEvent.id),
    supabase
      .from('payments')
      .select('id, participant_id, final_amount, payment_status, payment_method, created_at')
      .eq('event_id', selectedEvent.id),
    supabase
      .from('tickets')
      .select('id, status, used_at, participant_id')
      .eq('event_id', selectedEvent.id),
    supabase
      .from('shirt_inventory')
      .select('id, shirt_type, shirt_size, total_quantity, reserved_quantity, delivered_quantity')
      .eq('event_id', selectedEvent.id),
    supabase
      .from('participant_kit_items')
      .select('participant_id, status')
      .eq('event_id', selectedEvent.id),
  ]);

  if (participantsError) throw participantsError;
  if (paymentsError) throw paymentsError;
  if (ticketsError) throw ticketsError;
  if (inventoryError) throw inventoryError;
  if (kitError) throw kitError;

  return {
    events,
    selectedEvent,
    participants: participants ?? [],
    payments: payments ?? [],
    tickets: tickets ?? [],
    inventory: inventory ?? [],
      kitRows: kitRows ?? [],
  };
}

export default async function AdminDashboardPage({ searchParams }: { searchParams: Promise<{ eventId?: string }> }) {
  const { eventId } = await searchParams;
  const { canViewFinancial } = await getAdminAccessContext();
  const data = await getDashboardData(eventId);

  const participantRows = data.participants;
  const paymentRows = data.payments;
  const ticketRows = data.tickets;
  const inventoryRows = data.inventory;
  const kitRows = data.kitRows;

  const totalParticipants = participantRows.length;
  const confirmed = participantRows.filter((item) => String(item.registration_status ?? 'pending') === 'confirmed').length;
  const pending = participantRows.filter((item) => String(item.registration_status ?? 'pending') === 'pending').length;
  const cancelled = participantRows.filter((item) => String(item.registration_status ?? '') === 'cancelled').length;

  const paidPayments = paymentRows.filter((item) => String(item.payment_status ?? '') === 'paid');
  const pendingPayments = paymentRows.filter((item) => String(item.payment_status ?? 'pending') === 'pending');

  const confirmedRevenue = paidPayments.reduce((sum, item) => sum + Number(item.final_amount ?? 0), 0);
  const pendingRevenue = pendingPayments.reduce((sum, item) => sum + Number(item.final_amount ?? 0), 0);

  const pixCount = paidPayments.filter((item) => String(item.payment_method ?? '').toLowerCase() === 'pix').length;
  const cardCount = paidPayments.filter((item) => String(item.payment_method ?? '').toLowerCase() === 'credit_card').length;
  const courtesyCount = paidPayments.filter((item) => String(item.payment_method ?? '').toLowerCase() === 'courtesy').length;

  const issuedTickets = ticketRows.length;
  const checkins = ticketRows.filter((item) => String(item.status ?? '') === 'used').length;

  const inventoryReserved = inventoryRows.reduce((sum, item) => sum + Number(item.reserved_quantity ?? 0), 0);
  const inventoryDelivered = inventoryRows.reduce((sum, item) => sum + Number(item.delivered_quantity ?? 0), 0);
  const inventoryReceived = inventoryRows.reduce((sum, item) => sum + Number(item.total_quantity ?? 0), 0);
  const inventoryAvailable = inventoryRows.reduce(
    (sum, item) => sum + Math.max(0, Number(item.total_quantity ?? 0) - Number(item.reserved_quantity ?? 0) - Number(item.delivered_quantity ?? 0)),
    0,
  );
  const inventoryNeedToOrder = inventoryRows.reduce((sum, item) => {
    const deficit = Number(item.reserved_quantity ?? 0) + Number(item.delivered_quantity ?? 0) - Number(item.total_quantity ?? 0);
    return sum + Math.max(0, deficit);
  }, 0);

  const kitByParticipant = new Map<string, { total: number; delivered: number }>();
  for (const row of kitRows) {
    const key = String(row.participant_id ?? '');
    if (!key) continue;
    const prev = kitByParticipant.get(key) ?? { total: 0, delivered: 0 };
    kitByParticipant.set(key, {
      total: prev.total + 1,
      delivered: prev.delivered + (String(row.status ?? '') === 'delivered' ? 1 : 0),
    });
  }
  const fullyDeliveredKits = [...kitByParticipant.values()].filter((item) => item.total > 0 && item.total === item.delivered).length;

  const registrationsByDay = groupCount(participantRows.map((item) => String(item.created_at ?? '').slice(0, 10))).slice(0, 7).reverse();

  const revenueByBatch = groupSum(
    participantRows
      .filter((item) => String(item.registration_status ?? '') === 'confirmed')
      .map((item) => {
        const batch = Array.isArray(item.registration_batches) ? item.registration_batches[0] : item.registration_batches;
        return { label: batch?.name ? String(batch.name) : 'Sem lote', value: Number(item.final_amount ?? 0) };
      }),
  ).slice(0, 6);

  const salesByCategory = groupCount(
    participantRows.map((item) => {
      const category = Array.isArray(item.ticket_categories) ? item.ticket_categories[0] : item.ticket_categories;
      return category?.name ? String(category.name) : 'Sem categoria';
    }),
  ).slice(0, 6);

  const genderSplit = groupCount(participantRows.map((item) => String(item.gender ?? 'nao informado'))).slice(0, 6);
  const citySplit = groupCount(participantRows.map((item) => String(item.city ?? 'Nao informado'))).slice(0, 8);
  const shirtSplit = groupCount(participantRows.map((item) => `${String(item.shirt_type ?? 'Sem modelo')} ${String(item.shirt_size ?? '')}`)).slice(0, 8);

  const hasData = totalParticipants > 0 || paymentRows.length > 0 || ticketRows.length > 0;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader
            title="Dashboard Administrativo"
            subtitle={`Central operacional premium do Militrin com dados reais do evento selecionado: ${data.selectedEvent?.name ?? 'nenhum'}.`}
            actions={(
              <form action="/painel" className="flex items-center gap-2">
                <select
                  name="eventId"
                  defaultValue={data.selectedEvent?.id ?? ''}
                  className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                >
                  {data.events.map((event) => (
                    <option key={event.id} value={event.id}>{event.name}</option>
                  ))}
                </select>
                <button type="submit" className="h-10 rounded-xl bg-emerald-400 px-4 text-xs font-semibold text-slate-950">Aplicar</button>
              </form>
            )}
          />

          {!data.selectedEvent ? (
            <AdminEmptyState title="Nenhum evento cadastrado" description="Cadastre e ative um evento para liberar o painel operacional." />
          ) : (
            <>
              <AdminSection title="Resumo geral" description={`Evento selecionado: ${data.selectedEvent.name}`}>
                {!hasData ? (
                  <AdminEmptyState title="Sem dados para o evento" description="As métricas aparecem automaticamente quando houver inscrições, pagamentos e ingressos." />
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <AdminStatCard label="Total de inscritos" value={totalParticipants} />
                    <AdminStatCard label="Confirmados" value={confirmed} tone="success" />
                    <AdminStatCard label="Pendentes" value={pending} tone="warning" />
                    <AdminStatCard label="Cancelados" value={cancelled} />
                    <AdminStatCard label="Ingressos emitidos" value={issuedTickets} />
                    <AdminStatCard label="Check-ins realizados" value={checkins} />
                    <AdminStatCard label="Recebidas" value={inventoryReceived} />
                    <AdminStatCard label="Reservadas" value={inventoryReserved} />
                    <AdminStatCard label="Entregues" value={inventoryDelivered} />
                    <AdminStatCard label="Disponíveis" value={inventoryAvailable} />
                    <AdminStatCard label="Necessidade de encomenda" value={inventoryNeedToOrder} />
                    <AdminStatCard label="PIX" value={pixCount} />
                    <AdminStatCard label="Cartão" value={cardCount} />
                    <AdminStatCard label="Cortesias" value={courtesyCount} />
                    <AdminStatCard label="Kits entregues" value={fullyDeliveredKits} />
                  </div>
                )}
              </AdminSection>

              <AdminSection
                title="Financeiro resumido"
                description="Valores exibidos somente para acesso administrativo atual"
                actions={canViewFinancial ? <AdminStatusBadge status="confirmed" /> : <AdminStatusBadge status="pending" />}
              >
                {canViewFinancial ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <AdminStatCard label="Receita confirmada" value={money(confirmedRevenue)} tone="success" />
                    <AdminStatCard label="Receita pendente" value={money(pendingRevenue)} tone="warning" />
                  </div>
                ) : (
                  <AdminEmptyState title="Acesso financeiro restrito" description="Seu perfil atual não possui visualização de valores monetários." />
                )}
              </AdminSection>

              <div className="grid gap-4 xl:grid-cols-2">
                <AdminSection title="Inscrições por dia" description="Últimos dias com atividade">
                  <BarChart rows={registrationsByDay} emptyLabel="Sem dados de inscrições por dia." />
                </AdminSection>

                <AdminSection title="Receita por lote" description="Somente inscrições confirmadas">
                  {canViewFinancial ? <BarChart rows={revenueByBatch} emptyLabel="Sem dados de receita por lote." /> : <p className="text-sm text-slate-400">Oculto por política de acesso.</p>}
                </AdminSection>

                <AdminSection title="Vendas por categoria" description="Distribuição de inscritos por categoria">
                  <BarChart rows={salesByCategory} emptyLabel="Sem categorias com vendas." />
                </AdminSection>

                <AdminSection title="Masculino x feminino" description="Com base no gênero informado">
                  <BarChart rows={genderSplit} emptyLabel="Sem dados de gênero." />
                </AdminSection>

                <AdminSection title="Participantes por cidade" description="Top cidades registradas">
                  <BarChart rows={citySplit} emptyLabel="Sem dados de cidade." />
                </AdminSection>

                <AdminSection title="Camisetas por modelo e tamanho" description="Consumo de estoque por tipo e grade">
                  <BarChart rows={shirtSplit} emptyLabel="Sem dados de camisetas." />
                </AdminSection>
              </div>

              <div className="flex justify-end">
                <Link href="/inscricoes" className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500">
                  Abrir lista avançada de participantes
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
