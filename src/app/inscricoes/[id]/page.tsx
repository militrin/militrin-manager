import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/mvp/StatusBadge";
import { ParticipantHistory } from "./history";

async function getParticipant(id: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("participants")
    .select("id, registration_number, full_name, cpf, birth_date, gender, phone, email, city, shirt_type, shirt_size, amount, payment_status, registration_status, notes, created_at, payment_method, event_id")
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

export default async function ParticipantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const participant = await getParticipant(id);
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
                  <p className="text-lg font-semibold">#{participant.registration_number ?? "—"}</p>
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
                  <p>R$ {Number(participant.amount ?? 0).toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-400">Status</p>
                  <div className="mt-1 flex gap-2">
                    <StatusBadge label={participant.payment_status === "paid" ? "Pago" : "Pendente"} tone={participant.payment_status === "paid" ? "emerald" : "amber"} />
                    <StatusBadge label={participant.registration_status === "cancelled" ? "Cancelado" : "Ativo"} tone={participant.registration_status === "cancelled" ? "red" : "cyan"} />
                  </div>
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
