import Link from 'next/link';
import { AdminStatusBadge } from './AdminStatusBadge';
import { maskCpf } from './utils';

type AdminParticipantCardProps = {
  id: string;
  fullName: string;
  cpf: string;
  city: string | null;
  category: string;
  shirt: string;
  paymentStatus: string;
  ticketStatus: string;
};

export function AdminParticipantCard({
  id,
  fullName,
  cpf,
  city,
  category,
  shirt,
  paymentStatus,
  ticketStatus,
}: AdminParticipantCardProps) {
  return (
    <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base font-semibold text-slate-100">{fullName}</p>
        <div className="flex gap-2">
          <AdminStatusBadge status={paymentStatus} />
          <AdminStatusBadge status={ticketStatus} />
        </div>
      </div>
      <div className="mt-2 grid gap-1 text-sm text-slate-300">
        <p>CPF: {maskCpf(cpf)}</p>
        <p>Cidade: {city ?? '-'}</p>
        <p>Categoria: {category}</p>
        <p>Camiseta: {shirt}</p>
      </div>
      <div className="mt-3">
        <Link href={`/inscricoes/${id}`} className="inline-flex rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">
          Abrir ficha
        </Link>
      </div>
    </article>
  );
}
