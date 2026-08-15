import Image from 'next/image';
import type { ReactNode } from 'react';
import { MilitrinCard } from './MilitrinCard';
import { MilitrinStatusBadge } from './MilitrinStatusBadge';
import { getStatusLabel } from '@/lib/status-labels';

type MilitrinTicketCardProps = {
  eventName: string;
  date?: string | null;
  location?: string | null;
  holderName?: string;
  category?: string | null;
  batch?: string | null;
  shirt?: string | null;
  paymentStatus?: string | null;
  kitStatus?: string | null;
  checkinStatus?: string;
  status: string;
  qrUrl?: string | null;
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
          {date ? <p className="text-sm text-slate-300">Data: {date}</p> : null}
          {location ? <p className="text-sm text-slate-300">Local: {location}</p> : null}
          {category ? <p className="mt-2 text-sm text-slate-400">Categoria: {category}</p> : null}
          {batch ? <p className="text-sm text-slate-400">Lote: {batch}</p> : null}
          {shirt ? <p className="text-sm text-slate-400">Camiseta: {shirt}</p> : null}
          <div className="mt-3 grid gap-2 text-xs text-slate-300 sm:grid-cols-3">
            {paymentStatus ? <p>Pagamento: {getStatusLabel(paymentStatus)}</p> : null}
            {kitStatus ? <p>Kit: {getStatusLabel(kitStatus)}</p> : null}
            <p>Check-in: {getStatusLabel(checkinStatus)}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-3">
          <MilitrinStatusBadge status={status} />
          {qrUrl ? (
            <div className="rounded-xl border border-slate-700 bg-white p-2">
              <Image src={qrUrl} alt="QR Code do ingresso" width={132} height={132} unoptimized className="h-[132px] w-[132px]" />
            </div>
          ) : (
            <div className="flex h-[150px] w-[150px] items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-center text-xs font-medium text-amber-100">
              Ingresso aguardando conferência
            </div>
          )}
        </div>
      </div>
      {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
    </MilitrinCard>
  );
}
