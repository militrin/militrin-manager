import Link from "next/link";
import { StatusBadge } from "@/components/mvp/StatusBadge";
import { formatDateBR } from "@/lib/utils/date";

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
    base_amount: number;
    discount_amount: number;
    final_amount: number;
    registration_status: string;
    payment_status: string;
    reservation_status: string;
    reservation_expires_at: string | null;
    batch_name: string;
    batch_sequence_number: number | null;
    kit_status: string;
    created_at: string;
  };
};

function formatRemainingTime(expiresAt: string) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;

  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}min`;
  }

  return `${minutes}min`;
}

function getReservationBadge(participant: ParticipantCardProps["participant"]) {
  if (participant.payment_status === "paid" || participant.reservation_status === "confirmed") {
    return { label: "Pago / reserva confirmada", tone: "emerald" as const, helper: null };
  }

  if (participant.reservation_status === "expired") {
    return { label: "Reserva expirada", tone: "red" as const, helper: null };
  }

  if (participant.reservation_status === "released") {
    return { label: "Reserva liberada", tone: "slate" as const, helper: null };
  }

  if (participant.reservation_expires_at) {
    const remaining = formatRemainingTime(participant.reservation_expires_at);
    if (remaining) {
      return {
        label: "Aguardando pagamento",
        tone: "amber" as const,
        helper: `Reserva expira em ${remaining}.`,
      };
    }

    return { label: "Reserva expirada", tone: "red" as const, helper: null };
  }

  return { label: "Aguardando pagamento", tone: "amber" as const, helper: null };
}

export function ParticipantCard({ participant }: ParticipantCardProps) {
  const reservationBadge = getReservationBadge(participant);

  return (
    <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-slate-100">#{participant.registration_number ?? "-"} · {participant.full_name}</p>
          <p className="text-sm text-slate-400">{participant.cpf} · {participant.phone}</p>
        </div>
        <div className="flex gap-2">
          <StatusBadge label={participant.payment_status === "paid" ? "Pago" : "Pendente"} tone={participant.payment_status === "paid" ? "emerald" : "amber"} />
          <StatusBadge label={reservationBadge.label} tone={reservationBadge.tone} />
          <StatusBadge label={participant.kit_status === "delivered" ? "Kit entregue" : "Pendente"} tone={participant.kit_status === "delivered" ? "cyan" : "slate"} />
        </div>
      </div>

      {reservationBadge.helper ? <p className="mt-2 text-xs text-amber-300">{reservationBadge.helper}</p> : null}

      <div className="mt-4 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
        <div>
          <p className="text-slate-400">Lote</p>
          <p>
            {participant.batch_name}
            {participant.batch_sequence_number ? ` (#${participant.batch_sequence_number})` : ""}
          </p>
        </div>
        <div>
          <p className="text-slate-400">Cidade</p>
          <p>{participant.city ?? "—"}</p>
        </div>
        <div>
          <p className="text-slate-400">Camiseta</p>
          <p>{participant.shirt_type} · {participant.shirt_size}</p>
        </div>
        <div>
          <p className="text-slate-400">Preco-base</p>
          <p>R$ {Number(participant.base_amount ?? 0).toFixed(2)}</p>
        </div>
        <div>
          <p className="text-slate-400">Desconto</p>
          <p>R$ {Number(participant.discount_amount ?? 0).toFixed(2)}</p>
        </div>
        <div>
          <p className="text-slate-400">Valor final</p>
          <p>R$ {Number(participant.final_amount ?? 0).toFixed(2)}</p>
        </div>
        <div>
          <p className="text-slate-400">Inscrição</p>
          <p>{formatDateBR(participant.created_at)}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/inscricoes/${participant.id}`} className="rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-200">Detalhes</Link>
        <Link href={`/inscricoes/${participant.id}/editar`} className="rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-200">Editar</Link>
      </div>
    </div>
  );
}
