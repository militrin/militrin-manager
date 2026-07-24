import {
  BadgeDollarSign,
  Boxes,
  CircleDollarSign,
  ClipboardList,
  PackageCheck,
  Shirt,
  TrendingUp,
  Truck,
  Users,
} from "lucide-react";
import { RegistrationChart } from "@/components/dashboard/RegistrationChart";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { StatCard } from "@/components/dashboard/StatCard";
import { TopBar } from "@/components/dashboard/TopBar";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/mvp/EmptyState";

type DashboardParticipant = {
  id: string;
  amount: number | null;
  registration_status: string;
  payment_status: string;
  created_at: string;
};

type DashboardPayment = {
  amount: number | null;
  payment_status: string;
};

type DashboardStockItem = {
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
  shirt_type?: string;
  shirt_size?: string;
};

type DashboardRecentItem = {
  full_name: string;
  amount: number | null;
  payment_status: string;
  created_at: string;
};

async function getDashboardData() {
  const supabase = await createServerSupabaseClient();
  const { data: activeEvent, error: activeEventError } = await supabase.from("events").select("id").eq("is_active", true).maybeSingle();

  console.log("ACTIVE EVENT DATA:", activeEvent);
  console.log("ACTIVE EVENT ERROR:", activeEventError);

  if (activeEventError) {
    return {
      activeEventError,
    };
  }

  if (!activeEvent) return null;

  const [{ data: participants }, { data: payments }, { data: stock }, { data: kits }, { data: recent }] = await Promise.all([
    supabase.from("participants").select("id, amount, registration_status, payment_status, created_at").eq("event_id", activeEvent.id),
    supabase.from("payments").select("amount, payment_status").eq("event_id", activeEvent.id),
    supabase.from("shirt_inventory").select("total_quantity, reserved_quantity, delivered_quantity").eq("event_id", activeEvent.id),
    supabase.from("kit_deliveries").select("id").eq("event_id", activeEvent.id),
    supabase.from("participants").select("full_name, amount, payment_status, created_at").eq("event_id", activeEvent.id).order("created_at", { ascending: false }).limit(5),
  ]);

  const activeParticipants = (participants ?? []).filter((participant: DashboardParticipant) => participant.registration_status !== "cancelled");
  const paidPayments = (payments ?? []).filter((payment: DashboardPayment) => payment.payment_status === "paid");
  const pendingPayments = (payments ?? []).filter((payment: DashboardPayment) => payment.payment_status === "pending");
  const confirmedRevenue = paidPayments.reduce((acc: number, item: DashboardPayment) => acc + Number(item.amount ?? 0), 0);
  const totalAvailable = (stock ?? []).reduce((acc: number, item: DashboardStockItem) => acc + Math.max(0, item.total_quantity - item.reserved_quantity - item.delivered_quantity), 0);
  const lowStockItems = (stock ?? []).filter((item: DashboardStockItem) => Math.max(0, item.total_quantity - item.reserved_quantity - item.delivered_quantity) <= 5);
  const chartData = Array.from({ length: 6 }, (_, index) => {
    const monthNames = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun"];
    const monthValue = (participants ?? []).filter((participant: DashboardParticipant) => new Date(participant.created_at).getMonth() === index).length;
    return { label: monthNames[index], value: monthValue };
  });

  return {
    activeParticipants,
    paidPayments,
    pendingPayments,
    confirmedRevenue,
    kits: kits ?? [],
    totalAvailable,
    lowStockItems,
    chartData,
    recent,
    stockRows: stock ?? [],
    reservedCount: (stock ?? []).reduce((acc: number, item: DashboardStockItem) => acc + Number(item.reserved_quantity ?? 0), 0),
  };
}

export default async function Home() {
  const dashboardData = await getDashboardData();

  if (dashboardData && "activeEventError" in dashboardData && dashboardData.activeEventError) {
    const error = dashboardData.activeEventError as {
      message?: string;
      code?: string;
      details?: string;
      hint?: string;
    };

    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
          <Sidebar />
          <div className="flex-1 space-y-6">
            <TopBar title="Dashboard" subtitle="Visão geral do evento" />
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-5 text-red-200">
              <p className="font-semibold">Erro ao consultar o evento ativo no Supabase</p>
              <pre className="mt-3 whitespace-pre-wrap text-sm">{JSON.stringify({ message: error.message, code: error.code, details: error.details, hint: error.hint }, null, 2)}</pre>
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (!dashboardData) {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
          <Sidebar />
          <div className="flex-1 space-y-6">
            <TopBar title="Dashboard" subtitle="Visão geral do evento" />
            <EmptyState title="Nenhum evento ativo encontrado" description="Cadastre um evento ativo no Supabase para começar a usar o dashboard." />
          </div>
        </div>
      </main>
    );
  }

  const { activeParticipants, paidPayments, pendingPayments, confirmedRevenue, kits, totalAvailable, lowStockItems, chartData, recent, stockRows, reservedCount } = dashboardData;
  const recentItems = recent ?? [];
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />

        <div className="flex-1 space-y-6">
          <TopBar title="Dashboard" subtitle="Visão geral do evento" />

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <StatCard
              icon={Users}
              label="Total de inscritos"
              value={String(activeParticipants.length)}
              description="Inscrições ativas no evento atual"
              accent="bg-emerald-500/15 text-emerald-300"
            />
            <StatCard
              icon={CircleDollarSign}
              label="Pagamentos confirmados"
              value={`R$ ${confirmedRevenue.toFixed(2)}`}
              description={`${paidPayments.length} pagamentos pagos`}
              accent="bg-cyan-500/15 text-cyan-300"
            />
            <StatCard
              icon={BadgeDollarSign}
              label="Pagamentos pendentes"
              value={`${pendingPayments.length}`}
              description="Inscrições aguardando confirmação"
              accent="bg-amber-500/15 text-amber-300"
            />
            <StatCard
              icon={PackageCheck}
              label="Kits retirados"
              value={String(kits.length)}
              description="Entregas registradas"
              accent="bg-violet-500/15 text-violet-300"
            />
            <StatCard
              icon={Shirt}
              label="Camisetas disponíveis"
              value={String(totalAvailable)}
              description="Saldo disponível no estoque"
              accent="bg-fuchsia-500/15 text-fuchsia-300"
            />
            <StatCard
              icon={TrendingUp}
              label="Faturamento total"
              value={`R$ ${confirmedRevenue.toFixed(2)}`}
              description="Valor confirmado até o momento"
              accent="bg-emerald-500/15 text-emerald-300"
            />
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.6fr_0.9fr]">
            <SectionCard
              title="Inscrições por período"
              description="Volume de inscritos ao longo do semestre"
            >
              <RegistrationChart data={chartData} />
            </SectionCard>

            <SectionCard
              title="Indicadores de estoque baixo"
              description="Itens que merecem atenção imediata"
            >
              <div className="space-y-3">
                {lowStockItems.length === 0 ? (
                  <EmptyState title="Estoque saudável" description="Não há itens abaixo do limite de segurança no momento." />
                ) : lowStockItems.map((item: DashboardStockItem) => {
                  const available = Math.max(0, item.total_quantity - item.reserved_quantity - item.delivered_quantity);
                  return (
                    <div key={`${item.shirt_type}-${item.shirt_size}`} className="flex items-center justify-between rounded-2xl border border-slate-800/80 bg-slate-950/60 px-4 py-3">
                      <div>
                        <p className="font-medium text-slate-200">{item.shirt_type} · {item.shirt_size}</p>
                        <p className="text-sm text-slate-400">Restam apenas {available} unidades</p>
                      </div>
                      <div className="rounded-full bg-amber-500/15 px-3 py-1 text-sm font-semibold text-amber-300">{available}</div>
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.3fr_0.95fr]">
            <SectionCard
              title="Resumo de camisetas por modelo e tamanho"
              description="Disponível, reservada e entregue"
            >
              <div className="overflow-hidden rounded-2xl border border-slate-800/80">
                <table className="min-w-full divide-y divide-slate-800 text-sm">
                  <thead className="bg-slate-950/70 text-left text-slate-400">
                    <tr>
                      <th className="px-4 py-3 font-medium">Modelo</th>
                      <th className="px-4 py-3 font-medium">Tamanho</th>
                      <th className="px-4 py-3 font-medium">Disponível</th>
                      <th className="px-4 py-3 font-medium">Reservada</th>
                      <th className="px-4 py-3 font-medium">Entregue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 bg-slate-900/60 text-slate-200">
                    {stockRows.map((item: DashboardStockItem) => (
                      <tr key={`${item.shirt_type}-${item.shirt_size}`}>
                        <td className="px-4 py-3">{item.shirt_type}</td>
                        <td className="px-4 py-3">{item.shirt_size}</td>
                        <td className="px-4 py-3">{Math.max(0, item.total_quantity - item.reserved_quantity - item.delivered_quantity)}</td>
                        <td className="px-4 py-3">{item.reserved_quantity}</td>
                        <td className="px-4 py-3">{item.delivered_quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>

            <SectionCard
              title="Inscrições mais recentes"
              description="Últimas movimentações do sistema"
            >
              <div className="space-y-3">
                {recentItems.length === 0 ? (
                  <EmptyState title="Nenhuma inscrição recente" description="Acompanhe as próximas inscrições aqui." />
                ) : recentItems.map((item: DashboardRecentItem) => (
                  <div key={item.full_name} className="flex items-start justify-between rounded-2xl border border-slate-800/80 bg-slate-950/60 p-4">
                    <div>
                      <p className="font-medium text-slate-100">{item.full_name}</p>
                      <p className="text-sm text-slate-400">{new Date(item.created_at).toLocaleDateString("pt-BR")}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-emerald-300">R$ {Number(item.amount ?? 0).toFixed(2)}</p>
                      <p className={`text-xs ${item.payment_status === "paid" ? "text-emerald-400" : "text-amber-400"}`}>
                        {item.payment_status === "paid" ? "Pago" : "Pendente"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>

          <SectionCard
            title="Resumo operacional"
            description="Acompanhe o andamento do evento em um só lugar"
          >
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-800/80 bg-slate-950/60 p-4">
                <div className="flex items-center gap-3 text-emerald-300">
                  <Truck size={18} />
                  <p className="font-medium">Retirada de kits</p>
                </div>
                <p className="mt-3 text-2xl font-semibold text-white">{kits.length}</p>
                <p className="mt-1 text-sm text-slate-400">Kits registrados no evento ativo</p>
              </div>
              <div className="rounded-2xl border border-slate-800/80 bg-slate-950/60 p-4">
                <div className="flex items-center gap-3 text-cyan-300">
                  <ClipboardList size={18} />
                  <p className="font-medium">Check-in diário</p>
                </div>
                <p className="mt-3 text-2xl font-semibold text-white">{activeParticipants.length}</p>
                <p className="mt-1 text-sm text-slate-400">Inscrições ativas no evento</p>
              </div>
              <div className="rounded-2xl border border-slate-800/80 bg-slate-950/60 p-4">
                <div className="flex items-center gap-3 text-violet-300">
                  <Boxes size={18} />
                  <p className="font-medium">Camisetas reservadas</p>
                </div>
                <p className="mt-3 text-2xl font-semibold text-white">{reservedCount}</p>
                <p className="mt-1 text-sm text-slate-400">Camisetas reservadas para retirada</p>
              </div>
            </div>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
