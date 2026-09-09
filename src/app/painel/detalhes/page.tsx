import Link from 'next/link';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { AdminEmptyState, AdminPageHeader, AdminSection, AdminStatusBadge } from '@/components/admin';
import { hasPermission, requirePermission } from '@/lib/admin/permissions';
import { dashboardDetailHref, loadAdminDashboard, type DashboardMetricKey } from '@/lib/dashboard/admin-dashboard-data';
import { DASHBOARD_METRIC_SECTIONS, DASHBOARD_SECTION_PERMISSIONS } from '@/lib/dashboard/dashboard-permissions';

const metricKeys = new Set<DashboardMetricKey>([
  'people', 'registrations', 'confirmed', 'pending', 'expired', 'cancelled', 'tickets', 'checkins', 'complete_kits', 'shirt_coherence',
  'shirts_received', 'shirts_reserved', 'shirts_delivered', 'shirts_available', 'shirts_deficit',
  'revenue_confirmed', 'revenue_pending', 'revenue_refunded', 'pix', 'card', 'courtesy',
]);
function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

export default async function DashboardDetailsPage({ searchParams }: { searchParams: Promise<{ metric?: string; eventId?: string }> }) {
  const params = await searchParams;
  const key = metricKeys.has(params.metric as DashboardMetricKey) ? params.metric as DashboardMetricKey : 'registrations';
  const section = DASHBOARD_METRIC_SECTIONS[key];
  await requirePermission(DASHBOARD_SECTION_PERMISSIONS[section]);
  if (section === 'finance') await requirePermission('finance.view_amounts');
  const data = await loadAdminDashboard(params.eventId, [section]);
  const metric = data.metrics.get(key);
  const requiredPermissions = [...new Set((metric?.rows ?? []).flatMap((row) => row.requiredPermission ? [row.requiredPermission] : []))];
  const grantedPermissions = new Set((await Promise.all(requiredPermissions.map(async (permission) => [permission, await hasPermission(permission)] as const))).filter(([, granted]) => granted).map(([permission]) => permission));
  const backParams = params.eventId && params.eventId !== 'all' ? `?eventId=${encodeURIComponent(params.eventId)}` : '';
  const isMoney = key === 'revenue_confirmed' || key === 'revenue_pending' || key === 'revenue_refunded';

  return <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
    <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
      <Sidebar />
      <div className="min-w-0 flex-1 space-y-6">
        <AdminPageHeader title={metric?.label ?? 'Detalhes do indicador'} subtitle={`Registros que formam o indicador em ${data.selectedEvent?.name ?? 'todos os eventos'}.`} actions={<Link href={`/painel${backParams}`} className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500"><ArrowLeft className="size-4" />Voltar ao painel</Link>} />
        {!metric ? <AdminEmptyState title="Indicador indisponível" description="O indicador solicitado não existe para este contexto." /> : <>
          <AdminSection title={isMoney ? money(metric.value) : String(metric.value)} description={key === 'revenue_confirmed'
            ? `${metric.rows.length} pagamento(s). Soma das linhas = card. Somente LIVE pago; SANDBOX, fake, cortesia, legado desconhecido e estorno ficam de fora.`
            : key === 'revenue_refunded'
              ? `${metric.rows.length} pagamento(s) LIVE estornado(s). Histórico financeiro; não é receita atual. SANDBOX refunded não entra.`
            : key === 'shirt_coherence'
              ? `${metric.rows.length} ingresso(s). Combinação inequívoca é resolvível automaticamente; 0 ou várias variantes exigem revisão.`
              : `${metric.rows.length} registro(s) na composição exata do indicador.`} actions={<AdminStatusBadge status={metric.rows.length ? 'confirmed' : 'pending'} />}>
            {!metric.rows.length ? <AdminEmptyState title="Nenhum registro" description="Não há registros que atendam aos filtros deste indicador." /> : <div className="overflow-hidden rounded-2xl border border-slate-800">
              <div className="overflow-x-auto">
                <table className="admin-table-zebra min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="bg-slate-950/80 text-left text-xs uppercase tracking-wider text-slate-400"><tr><th className="px-4 py-3">Pessoa / item</th><th className="px-4 py-3">Referência</th><th className="px-4 py-3">Situação</th><th className="px-4 py-3">Pendência / quantidade</th><th className="px-4 py-3 text-right">Ação</th></tr></thead>
                  <tbody className="divide-y divide-slate-800">{metric.rows.map((row) => <tr key={`${row.id}-${row.status}`} data-row-state={row.status === 'cancelled' || row.status === 'expired' ? 'cancelled' : row.status === 'refunded' ? 'refunded' : undefined}>
                    <td className="px-4 py-3 font-medium text-white">{row.primary}</td><td className="px-4 py-3 text-slate-300">{row.secondary}</td><td className="px-4 py-3"><span className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300">{row.status}</span></td>
                    <td className="max-w-sm px-4 py-3 text-slate-300">{[row.issue, row.value == null ? null : isMoney ? money(row.value) : row.value].filter((part) => part != null && part !== '').join(' · ') || '—'}</td>
                    <td className="px-4 py-3 text-right">{row.href && (!row.requiredPermission || grantedPermissions.has(row.requiredPermission)) ? <Link href={row.href} className="inline-flex items-center gap-1 font-semibold text-emerald-300 hover:text-emerald-200">{row.actionLabel ?? 'Abrir'}<ArrowUpRight className="size-4" /></Link> : <span className="text-xs text-slate-500">Somente leitura</span>}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </div>}
          </AdminSection>
          <p className="text-xs text-slate-500">URL compartilhável: {dashboardDetailHref(key, params.eventId)}</p>
        </>}
      </div>
    </div>
  </main>;
}
