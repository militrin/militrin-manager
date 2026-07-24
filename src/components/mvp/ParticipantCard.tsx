import Link from "next/link";
import { StatusBadge } from "@/components/mvp/StatusBadge";

type ParticipantCardProps = {
  participant: {
    id: string;
    registration_number: number | null;
    full_name: string;
    cpf: string;
    phone: string;
    city: string | null;
    shirt_type: string;
    shirt_size: string;
    amount: number | null;
    registration_status: string;
    payment_status: string;
    kit_status: string;
    created_at: string;
  };
};

export function ParticipantCard({ participant }: ParticipantCardProps) {
  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-slate-100">#{participant.registration_number ?? "-"} · {participant.full_name}</p>
          <p className="text-sm text-slate-400">{participant.cpf} · {participant.phone}</p>
        </div>
        <div className="flex gap-2">
          <StatusBadge label={participant.payment_status === "paid" ? "Pago" : "Pendente"} tone={participant.payment_status === "paid" ? "emerald" : "amber"} />
          <StatusBadge label={participant.kit_status === "delivered" ? "Kit entregue" : "Pendente"} tone={participant.kit_status === "delivered" ? "cyan" : "slate"} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
        <div>
          <p className="text-slate-400">Cidade</p>
          <p>{participant.city ?? "—"}</p>
        </div>
        <div>
          <p className="text-slate-400">Camiseta</p>
          <p>{participant.shirt_type} · {participant.shirt_size}</p>
        </div>
        <div>
          <p className="text-slate-400">Valor</p>
          <p>R$ {Number(participant.amount ?? 0).toFixed(2)}</p>
        </div>
        <div>
          <p className="text-slate-400">Inscrição</p>
          <p>{new Date(participant.created_at).toLocaleDateString("pt-BR")}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/inscricoes/${participant.id}`} className="rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-200">Detalhes</Link>
        <Link href={`/inscricoes/${participant.id}/editar`} className="rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-200">Editar</Link>
      </div>
    </div>
  );
}
