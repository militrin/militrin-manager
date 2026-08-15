import Link from 'next/link';
import {
  Banknote, Ban, Boxes, CheckCircle2, ClipboardList, Clock3, CreditCard,
  FileSpreadsheet, Gift, PackageCheck, QrCode, ScanLine, Shirt, Ticket,
  TriangleAlert, Truck, UserPlus, Users, WalletCards, Warehouse,
} from 'lucide-react';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { AdminEmptyState, AdminPageHeader, AdminSection, AdminStatCard, AdminStatusBadge } from '@/components/admin';
import { getAdminAccessContext } from '@/lib/admin/access';
import { hasPermission } from '@/lib/admin/permissions';
import { dashboardDetailHref, loadAdminDashboard, type DashboardMetricKey } from '@/lib/dashboard/admin-dashboard-data';
import { DashboardEventSelector } from './dashboard-event-selector';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

type QuickAction = {
  label: string;
  href: string;
  icon: typeof Ticket;
  allowed: boolean;
};

export default async function AdminDashboardPage({ searchParams }: { searchParams: Promise<{ eventId?: string }> }) {
  const { eventId } = await searchParams;
  const [{ canViewFinancial }, data, canIssue, canManageInventory, canOperateKits, canImport, canViewPeople, canViewFinance] = await Promise.all([
    getAdminAccessContext(),
    loadAdminDashboard(eventId),
    hasPermission('participants.create'),
    hasPermission('inventory.view'),
    hasPermission('kits.view'),
    hasPermission('imports.view'),
    hasPermission('participants.view'),
    hasPermission('finance.view'),
  ]);
  const selectedId = data.selectedEvent?.id ?? 'all';
  const metric = (key: DashboardMetricKey) => data.metrics.get(key) ?? { key, label: key, value: 0, rows: [] };
  const href = (key: DashboardMetricKey) => dashboardDetailHref(key, selectedId);
  const shirtAttention = metric('shirt_coherence').value;
  const eventQuery = selectedId === 'all' ? '' : `?eventId=${encodeURIComponent(selectedId)}`;
  const quickActions: QuickAction[] = [
    { label: 'Emitir ingresso', href: `/ingressos/emitir${eventQuery}`, icon: UserPlus, allowed: canIssue },
    { label: 'Nova encomenda', href: `/camisetas${eventQuery}`, icon: Shirt, allowed: canManageInventory },
    { label: 'Entrega de kits', href: `/operacoes${eventQuery}`, icon: PackageCheck, allowed: canOperateKits },
    { label: 'Importar planilha', href: `/importacoes${eventQuery}`, icon: FileSpreadsheet, allowed: canImport },
    { label: 'Ver público', href: `/painel/usuarios${eventQuery}`, icon: Users, allowed: canViewPeople },
    { label: 'Ver receitas', href: `/financeiro${eventQuery}`, icon: WalletCards, allowed: canViewFinance },
  ].filter((action) => action.allowed);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-3 py-4 text-slate-100 sm:px-5 lg:px-6">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4 lg:flex-row">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-4">
          <AdminPageHeader
            compact
            title="Dashboard Administrativo"
            subtitle={`Visão operacional rastreável de ${data.selectedEvent?.name ?? 'todos os eventos'}. Cada indicador abre os registros que o compõem.`}
            actions={<DashboardEventSelector events={data.events} selectedId={selectedId} />}
          />

          {!data.events.length ? <AdminEmptyState title="Nenhum evento cadastrado" description="Cadastre e ative um evento para liberar o painel operacional." /> : <>
            <AdminSection compact title="Pessoas e inscrições">
              {!data.hasData ? <AdminEmptyState title="Sem dados no período" description="Os indicadores aparecerão quando houver inscrições, pagamentos ou ingressos." /> : <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
                <AdminStatCard compact label="Pessoas no evento" value={metric('people').value} href={href('people')} icon={Users} hint="Cadastros globais vinculados" />
                <AdminStatCard compact label="Inscrições comerciais" value={metric('registrations').value} href={href('registrations')} icon={ClipboardList} hint="Itens de pedido no evento" />
                <AdminStatCard compact label="Confirmadas" value={metric('confirmed').value} href={href('confirmed')} icon={CheckCircle2} tone="success" />
                <AdminStatCard compact label="Pendentes" value={metric('pending').value} href={href('pending')} icon={Clock3} tone="warning" />
                <AdminStatCard compact label="Canceladas" value={metric('cancelled').value} href={href('cancelled')} icon={Ban} />
              </div>}
            </AdminSection>

            {data.hasData ? <AdminSection compact title="Ingressos e operação">
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                <AdminStatCard compact label="Ingressos emitidos" value={metric('tickets').value} href={href('tickets')} icon={Ticket} />
                <AdminStatCard compact label="Check-ins realizados" value={metric('checkins').value} href={href('checkins')} icon={ScanLine} tone="info" />
                <AdminStatCard compact label="Kits completos entregues" value={metric('complete_kits').value} href={href('complete_kits')} icon={PackageCheck} tone="success" />
                <div className="sm:col-span-2 xl:col-span-2">
                  <AdminStatCard compact label={shirtAttention ? 'Consistência operacional' : 'Camisetas consistentes'} value={shirtAttention ? `${shirtAttention} com atenção` : 'Tudo certo'} hint={shirtAttention ? 'Ingressos ativos sem variante canônica de camiseta.' : 'Ingressos ativos possuem variant_id quando exigido.'} href={href('shirt_coherence')} actionLabel={shirtAttention ? 'Corrigir pendências' : 'Auditar vínculos'} icon={shirtAttention ? TriangleAlert : Shirt} tone={shirtAttention ? 'warning' : 'success'} />
                </div>
              </div>
            </AdminSection> : null}

            {data.hasData ? <AdminSection compact title="Estoque de camisetas">
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
                <AdminStatCard compact label="Recebidas" value={metric('shirts_received').value} href={href('shirts_received')} icon={Boxes} />
                <AdminStatCard compact label="Reservadas" value={metric('shirts_reserved').value} href={href('shirts_reserved')} icon={Shirt} />
                <AdminStatCard compact label="Entregues" value={metric('shirts_delivered').value} href={href('shirts_delivered')} icon={Truck} />
                <AdminStatCard compact label="Disponíveis" value={metric('shirts_available').value} href={href('shirts_available')} icon={Warehouse} tone="success" />
                <AdminStatCard compact label="Faltam encomendar" value={metric('shirts_deficit').value} href={href('shirts_deficit')} icon={TriangleAlert} tone={metric('shirts_deficit').value ? 'danger' : 'default'} />
              </div>
              <p className="mt-2 text-[11px] leading-4 text-slate-400">Disponibilidade física = recebidas − entregues. Reservas representam demanda, não saída física.</p>
            </AdminSection> : null}

            <AdminSection compact title="Financeiro" actions={canViewFinancial ? <AdminStatusBadge status="confirmed" /> : <AdminStatusBadge status="pending" />}>
              {canViewFinancial ? <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
                <AdminStatCard compact label="Receita confirmada" value={money(metric('revenue_confirmed').value)} href={href('revenue_confirmed')} icon={Banknote} tone="success" />
                <AdminStatCard compact label="Receita pendente" value={money(metric('revenue_pending').value)} href={href('revenue_pending')} icon={Clock3} tone="warning" />
                <AdminStatCard compact label="PIX" value={metric('pix').value} href={href('pix')} icon={QrCode} />
                <AdminStatCard compact label="Cartão" value={metric('card').value} href={href('card')} icon={CreditCard} />
                <AdminStatCard compact label="Cortesias" value={metric('courtesy').value} href={href('courtesy')} icon={Gift} />
              </div> : <AdminEmptyState title="Acesso financeiro restrito" description="Seu perfil não possui permissão para visualizar valores monetários." />}
            </AdminSection>

            {quickActions.length ? <section aria-labelledby="quick-actions-title" className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-800/80 bg-slate-900/60 px-4 py-3">
              <h2 id="quick-actions-title" className="mr-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Ações rápidas</h2>
              {quickActions.map(({ label, href: actionHref, icon: Icon }) => <Link key={label} href={actionHref} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950/60 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:border-emerald-400/60 hover:bg-emerald-500/10 hover:text-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"><Icon className="size-3.5" aria-hidden />{label}</Link>)}
            </section> : null}
          </>}
        </div>
      </div>
    </main>
  );
}
