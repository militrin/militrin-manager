import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { formatDateTimeBR } from "@/lib/utils/date";

const statusOptions = ["pending", "paid", "cancelled", "expired", "courtesy"];

async function getFinanceRows(status: string) {
  const supabase = await createServerSupabaseClient();
  const { data: activeEvent } = await supabase.from("events").select("id, name").eq("is_active", true).maybeSingle();
  if (!activeEvent?.id) {
    return { rows: [], eventName: null as string | null };
  }

  let paymentStatusFilter: string | null = status;
  let paymentMethodFilter: string | null = null;

  if (status === "courtesy") {
    paymentStatusFilter = "paid";
    paymentMethodFilter = "courtesy";
  }

  let query = supabase
    .from("payments")
    .select("id, amount, discount_amount, final_amount, payment_method, payment_status, created_at, paid_at, participants!inner(full_name, cpf)")
    .eq("event_id", activeEvent.id)
    .order("created_at", { ascending: false })
    .limit(200);

  if (paymentStatusFilter) {
    query = query.eq("payment_status", paymentStatusFilter);
  }

  if (paymentMethodFilter) {
    query = query.eq("payment_method", paymentMethodFilter);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []).map((item) => {
    const participant = Array.isArray(item.participants) ? item.participants[0] : item.participants;
    return {
      id: String(item.id),
      full_name: String(participant?.full_name ?? "-"),
      cpf: String(participant?.cpf ?? "-"),
      event_name: String(activeEvent.name ?? "Evento ativo"),
      amount: Number(item.amount ?? 0),
      discount_amount: Number(item.discount_amount ?? 0),
      final_amount: Number(item.final_amount ?? 0),
      payment_method: String(item.payment_method ?? "-"),
      payment_status: String(item.payment_status ?? "pending"),
      created_at: String(item.created_at),
      paid_at: item.paid_at ? String(item.paid_at) : null,
    };
  });

  return {
    rows,
    eventName: String(activeEvent.name ?? "Evento ativo"),
  };
}

export default async function FinanceiroPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const params = await searchParams;
  const status = params.status && statusOptions.includes(params.status) ? params.status : "pending";
  const { rows, eventName } = await getFinanceRows(status);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Financeiro" subtitle="Acompanhamento de pagamentos" />
          <SectionCard title="Pagamentos" description="Filtre por status e acompanhe valores do evento.">
            <div className="mb-4 flex flex-wrap gap-2">
              {statusOptions.map((option) => (
                <a
                  key={option}
                  href={`/financeiro?status=${option}`}
                  className={`rounded-xl border px-3 py-2 text-sm ${status === option ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200" : "border-slate-700 text-slate-300"}`}
                >
                  {option}
                </a>
              ))}
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-800/80">
              <table className="min-w-full divide-y divide-slate-800 text-sm">
                <thead className="bg-slate-950/70 text-left text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Nome</th>
                    <th className="px-4 py-3 font-medium">CPF</th>
                    <th className="px-4 py-3 font-medium">Evento</th>
                    <th className="px-4 py-3 font-medium">Valor</th>
                    <th className="px-4 py-3 font-medium">Cupom</th>
                    <th className="px-4 py-3 font-medium">Forma</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Criado</th>
                    <th className="px-4 py-3 font-medium">Pago</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-900/60 text-slate-200">
                  {rows.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-slate-400" colSpan={9}>Nenhum pagamento encontrado para o filtro selecionado.</td>
                    </tr>
                  ) : rows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-4 py-3">{row.full_name}</td>
                      <td className="px-4 py-3">{row.cpf}</td>
                      <td className="px-4 py-3">{eventName ?? row.event_name}</td>
                      <td className="px-4 py-3">R$ {row.final_amount.toFixed(2)}</td>
                      <td className="px-4 py-3">R$ {row.discount_amount.toFixed(2)}</td>
                      <td className="px-4 py-3">{row.payment_method}</td>
                      <td className="px-4 py-3">{row.payment_status}</td>
                      <td className="px-4 py-3">{formatDateTimeBR(row.created_at, " às ")}</td>
                      <td className="px-4 py-3">{row.paid_at ? formatDateTimeBR(row.paid_at, " às ") : "--"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
