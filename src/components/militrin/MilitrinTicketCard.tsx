import Image from 'next/image';
import type { ReactNode } from 'react';
import { MilitrinCard } from './MilitrinCard';
import { MilitrinStatusBadge } from './MilitrinStatusBadge';

type MilitrinTicketCardProps = {
  eventName: string;
  date: string;
  location: string;
  holderName?: string;
  category: string;
  batch: string;
  shirt: string;
  paymentStatus?: string;
  kitStatus?: string;
  checkinStatus?: string;
  status: string;
  qrUrl: string;
  actions?: ReactNode;
};

export function MilitrinTicketCard({
  eventName,
  date,
  location,
  holderName,
  category,
  batch,
  shirt,
  paymentStatus,
  kitStatus,
  checkinStatus,
  status,
  qrUrl,
  actions,
}: MilitrinTicketCardProps) {
  return (
    <MilitrinCard className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[220px] flex-1">
          <p className="text-lg font-semibold text-white">{eventName}</p>
          <p className="text-sm text-slate-300">Titular: {holderName ?? 'Titular ainda nao definido'}</p>
          <p className="text-sm text-slate-300">Data: {date}</p>
          <p className="text-sm text-slate-300">Local: {location}</p>
          <p className="mt-2 text-sm text-slate-400">Categoria: {category}</p>
          <p className="text-sm text-slate-400">Lote: {batch}</p>
          <p className="text-sm text-slate-400">Camiseta: {shirt}</p>
          <div className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-3">
            <p>Pagamento: {paymentStatus ?? '-'}</p>
            <p>Kit: {kitStatus ?? '-'}</p>
            <p>Check-in: {checkinStatus ?? '-'}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-3">
          <MilitrinStatusBadge status={status} />
          <div className="rounded-xl border border-slate-700 bg-white p-2">
            <Image src={qrUrl} alt="QR Code do ingresso" width={132} height={132} unoptimized className="h-[132px] w-[132px]" />
          </div>
        </div>
      </div>
      {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
    </MilitrinCard>
  );
}
