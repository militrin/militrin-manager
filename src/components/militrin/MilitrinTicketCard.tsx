import Image from 'next/image';
import type { ReactNode } from 'react';
import { Calendar, MapPin, Ticket as TicketIcon, Users } from 'lucide-react';
import { MilitrinBadge } from './MilitrinBadge';
import { MilitrinStatusBadge } from './MilitrinStatusBadge';
import { checkinStatusChip, kitStatusChip, paymentStatusChip, type StatusChip } from './status-chips';
import { cx } from './utils';
import { militrinTokens, militrinType } from './tokens';
import { getStatusLabel } from '@/lib/status-labels';

type MilitrinTicketCardProps = {
  eventName: string;
  status: string;
  date?: string | null;
  location?: string | null;
  holderName: string;
  category?: string | null;
  batch?: string | null;
  shirtType?: string | null;
  shirtSize?: string | null;
  paymentStatus: string;
  kitStatus?: 'delivered' | 'pending' | null;
  checkinDone: boolean;
  qrUrl?: string | null;
  actions?: ReactNode;
};

export function MilitrinTicketCard({
  eventName,
  status,
  date,
  location,
  holderName,
  category,
  batch,
  shirtType,
  shirtSize,
  paymentStatus,
  kitStatus = null,
  checkinDone,
  qrUrl,
  actions,
}: MilitrinTicketCardProps) {
  // Estados terminais (nunca vao ter QR, independente de confirmacao futura)
  // -- diferente de "aguardando", que e transitorio. Sem isso, um pedido
  // expirado/reembolsado/cancelado herdava o mesmo aviso amarelo de "aguardando
  // conferencia", como se fosse so uma questao de tempo.
  const TERMINAL_STATUSES = ['cancelled', 'canceled', 'expired', 'refunded'];
  const isTerminal = TERMINAL_STATUSES.includes(status.toLowerCase());
  const chips = [paymentStatusChip(paymentStatus), kitStatusChip(kitStatus), checkinStatusChip(checkinDone)].filter(
    (chip): chip is StatusChip => chip !== null,
  );

  return (
    <div className={cx(militrinTokens.radiusMd, militrinTokens.surfaceMuted, militrinTokens.shadow, 'overflow-hidden')}>
      <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[1.05fr_1.35fr_180px] lg:gap-5">
        {/* Identidade do evento (nivel 1-2): nome, status principal, categoria/lote. */}
        <div className="min-w-0 space-y-2.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className={cx('min-w-0 truncate', militrinType.cardTitle)} title={eventName}>{eventName}</p>
            <MilitrinStatusBadge status={status} />
          </div>
          {category || batch ? (
            <div className="flex flex-wrap gap-1.5">
              {category ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-200">
                  <Users size={11} />{category}
                </span>
              ) : null}
              {batch ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-200">
                  <TicketIcon size={11} />{batch}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Dados / status (nivel 3-5): data/local, titular/camiseta, chips operacionais. */}
        <div className="min-w-0 space-y-3 lg:border-l lg:border-slate-800/80 lg:pl-5">
          <div className={cx('flex flex-wrap gap-x-4 gap-y-1', militrinType.body)}>
            {date ? <span className="inline-flex items-center gap-1.5"><Calendar size={14} className="text-slate-500" />{date}</span> : null}
            {location ? <span className="inline-flex items-center gap-1.5"><MapPin size={14} className="text-slate-500" />{location}</span> : null}
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <div>
              <p className={militrinType.label}>Titular</p>
              <p className={cx('truncate', militrinType.body)}>{holderName}</p>
            </div>
            {shirtSize ? (
              <div>
                <p className={militrinType.label}>{shirtType ?? 'Camiseta'}</p>
                <p className={militrinType.body}>{shirtSize}</p>
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <MilitrinBadge key={chip.label} tone={chip.tone}>
                <span className="inline-flex items-center gap-1">
                  <chip.icon size={11} />{chip.label}
                </span>
              </MilitrinBadge>
            ))}
          </div>
        </div>

        {/* QR Code: area propria, sempre do mesmo tamanho que o estado de espera/cancelado para nao "pular" a altura do card na lista. */}
        <div className="flex flex-col items-center justify-center gap-2 border-t border-dashed border-slate-800 pt-4 lg:border-l lg:border-t-0 lg:border-dashed lg:border-slate-800/80 lg:pl-5 lg:pt-0">
          {qrUrl ? (
            <>
              <div className="rounded-xl border border-slate-700 bg-white p-2">
                <Image src={qrUrl} alt="QR Code do ingresso" width={160} height={160} unoptimized className="h-40 w-40" />
              </div>
              <p className={cx('text-center', militrinType.micro)}>Apresente este QR Code para retirar seu kit</p>
            </>
          ) : (
            <div
              className={cx(
                'flex h-40 w-40 items-center justify-center rounded-xl border p-3 text-center text-xs font-medium',
                isTerminal ? 'border-slate-700 bg-slate-900/60 text-slate-400' : 'border-amber-500/30 bg-amber-500/10 text-amber-100',
              )}
            >
              {isTerminal ? `Ingresso ${getStatusLabel(status).toLowerCase()}` : 'Ingresso aguardando conferência'}
            </div>
          )}
        </div>
      </div>

      {actions ? <div className="flex flex-wrap gap-2 border-t border-slate-800/80 p-4 sm:p-5 lg:px-5">{actions}</div> : null}
    </div>
  );
}
