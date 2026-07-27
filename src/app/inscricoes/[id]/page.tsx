import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/mvp/StatusBadge";
import { ParticipantHistory } from "./history";
import { PaymentPanel } from "./payment-panel";

async function getParticipant(id: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("participants")
    .select("id, full_name, cpf, birth_date, gender, phone, email, city, shirt_type, shirt_size, base_amount, discount_amount, final_amount, registration_status, notes, created_at, event_id, user_id, payments(payment_status, payment_method, pix_code, pix_qrcode, expires_at, paid_at, final_amount, created_at)")
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

export default async function ParticipantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const participant = await getParticipant(id);
  const supabase = await createServerSupabaseClient();

  const [profileResult, historyResult] = await Promise.all([
    participant.user_id
      ? supabase.rpc('get_customer_profile', { p_user_id: participant.user_id })
      : Promise.resolve({ data: null }),
    supabase
      .from('participation_history')
      .select('id, status', { count: 'exact' })
      .or(`participant_id.eq.${participant.id},cpf.eq.${participant.cpf}`),
  ]);

  const profile = (Array.isArray(profileResult.data) ? profileResult.data[0] : profileResult.data) as Record<string, unknown> | null;
  const historyRows = historyResult.data ?? [];
  const confirmedHistoryCount = historyRows.filter((item) => item.status === 'confirmed').length;
  const duplicateHistoryCount = historyRows.filter((item) => item.status === 'duplicate' || item.status === 'review_required').length;

  const latestPayment = Array.isArray(participant.payments)
    ? participant.payments
        .slice()
        .sort((a, b) => new Date(String(b.created_at ?? 0)).getTime() - new Date(String(a.created_at ?? 0)).getTime())[0] ?? null
    : null;

  return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
          <Sidebar />
          <div className="flex-1 space-y-6">
            <TopBar title="Detalhes do inscrito" subtitle="Visualização e edição" />
            <SectionCard title="Dados principais" description="Informações completas do participante.">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="text-sm text-slate-400">Número</p>
                  <p className="text-lg font-semibold">—</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400">Nome</p>
                  <p className="text-lg font-semibold">{participant.full_name}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400">CPF</p>
                  <p>{participant.cpf}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400">Telefone</p>
                  <p>{participant.phone}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400">Cidade</p>
                  <p>{participant.city ?? "—"}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400">Camiseta</p>
                  <p>{participant.shirt_type} · {participant.shirt_size}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400">Valor</p>
                  <p>R$ {Number(participant.final_amount ?? 0).toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400">Status</p>
                  <div className="mt-1 flex gap-2">
                    <StatusBadge label={latestPayment?.payment_status === "paid" ? "Pago" : "Pendente"} tone={latestPayment?.payment_status === "paid" ? "emerald" : "amber"} />
                    <StatusBadge label={participant.registration_status === "cancelled" ? "Cancelado" : "Ativo"} tone={participant.registration_status === "cancelled" ? "red" : "cyan"} />
                  </div>
                </div>
              </div>

              <PaymentPanel
                payment={latestPayment ? {
                  payment_status: String(latestPayment.payment_status ?? "pending"),
                  payment_method: latestPayment.payment_method ? String(latestPayment.payment_method) : null,
                  pix_code: latestPayment.pix_code ? String(latestPayment.pix_code) : null,
                  pix_qrcode: latestPayment.pix_qrcode ? String(latestPayment.pix_qrcode) : null,
                  expires_at: latestPayment.expires_at ? String(latestPayment.expires_at) : null,
                  paid_at: latestPayment.paid_at ? String(latestPayment.paid_at) : null,
                  final_amount: Number(latestPayment.final_amount ?? participant.final_amount ?? 0),
                } : null}
              />

              <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="text-sm font-semibold text-slate-100">Conta e histórico importado</p>
                <div className="mt-3 grid gap-2 text-sm text-slate-300 md:grid-cols-2">
                  <p>Status da conta: {profile?.account_status ? String(profile.account_status) : 'legacy_without_account'}</p>
                  <p>Senha pendente: {Boolean(profile?.must_change_password) ? 'Sim' : 'Não'}</p>
                  <p>Perfil incompleto: {Boolean(profile?.must_complete_profile) ? 'Sim' : 'Não'}</p>
                  <p>Participações confirmadas: {confirmedHistoryCount}</p>
                  <p>Possíveis duplicidades: {duplicateHistoryCount}</p>
                  <p>Nível: {profile?.loyalty_tier_name ? String(profile.loyalty_tier_name) : 'Novato'}</p>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Link href="/importacoes" className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Vincular histórico</Link>
                  <Link href="/importacoes" className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Enviar ativação</Link>
                  <Link href="/importacoes" className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Reemitir QR Code</Link>
                  <Link href="/importacoes" className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Forçar redefinição de senha</Link>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link href={`/inscricoes/${participant.id}/editar`} className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950">Editar</Link>
                <Link href="/inscricoes" className="rounded-2xl border border-slate-700 px-4 py-2 text-sm text-slate-300">Voltar à lista</Link>
              </div>
              <ParticipantHistory participantId={participant.id} />
            </SectionCard>
          </div>
        </div>
      </main>
    );
}
