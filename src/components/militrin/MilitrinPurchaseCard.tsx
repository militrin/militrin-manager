import type { ReactNode } from 'react';
import { Calendar, MapPin } from 'lucide-react';
import { MilitrinBadge } from './MilitrinBadge';
import { MilitrinStatusBadge, resolveStatusTone } from './MilitrinStatusBadge';
import { paymentStatusChip } from './status-chips';
import { cx } from './utils';
import { militrinTokens, militrinType } from './tokens';
import { parseDateInput } from '@/lib/utils/date';

const DATE_BADGE_TONE_CLASS = {
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  danger: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  info: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  neutral: 'border-slate-600/60 bg-slate-800/40 text-slate-200',
} as const;

// Mini calendario de identidade do pedido -- mesma cor do badge de status
// principal (resolveStatusTone), pra nunca contar uma historia diferente da
// badge ao lado. So aparece quando ha uma data valida pra mostrar.
function OrderDateBadge({ date, tone }: { date: Date; tone: keyof typeof DATE_BADGE_TONE_CLASS }) {
  const month = new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(date).replace('.', '').toUpperCase();
  return (
    <div className={cx('flex h-16 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border text-center', DATE_BADGE_TONE_CLASS[tone])}>
      <span className="text-[10px] font-bold uppercase tracking-wide">{month}</span>
      <span className="text-lg font-bold leading-none">{date.getDate()}</span>
      <span className="text-[10px] opacity-80">{date.getFullYear()}</span>
    </div>
  );
}

type MilitrinPurchaseCardProps = {
  orderNumber: string;
  status: string;
  eventName: string;
  /** Valor de data ja existente na fonte (ex.: events.starts_at ou created_at) -- o componente so formata, nunca calcula uma data nova. */
  dateValue?: string | null;
  /**
   * 'event': a data mostrada e a data do evento (identidade do pedido).
   * 'order': so a data de criacao do pedido esta disponivel -- o rotulo
   * deixa isso explicito em vez de sugerir que e a data do evento.
   */
  dateKind: 'event' | 'order';
  location?: string | null;
  summaryLine: string;
  paymentStatus: string;
  finalAmount: string;
  paymentMethod?: string | null;
  expirationLabel?: string | null;
  expirationValue?: string | null;
  expirationTone?: 'warning' | 'danger';
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
};

export function MilitrinPurchaseCard({
  orderNumber,
  status,
  eventName,
  dateValue,
  dateKind,
  location,
  summaryLine,
  paymentStatus,
  finalAmount,
  paymentMethod,
  expirationLabel,
  expirationValue,
  expirationTone = 'warning',
  primaryAction,
  secondaryAction,
}: MilitrinPurchaseCardProps) {
  const date = parseDateInput(dateValue);
  const tone = resolveStatusTone(status);
  const chip = paymentStatusChip(paymentStatus);
  const dateText = date ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }).format(date) : null;

  return (
    <div className={cx(militrinTokens.radiusMd, militrinTokens.surfaceMuted, militrinTokens.shadow, 'overflow-hidden')}>
      <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[1.5fr_1fr_240px] lg:gap-5">
        {/* Identidade do pedido/evento */}
        <div className="flex min-w-0 gap-3">
          {date ? <OrderDateBadge date={date} tone={tone} /> : null}
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className={militrinType.label}>Pedido {orderNumber}</p>
              <MilitrinStatusBadge status={status} />
            </div>
            <p className={cx('truncate', militrinType.cardTitle)} title={eventName}>{eventName}</p>
            {dateText || location ? (
              <div className={cx('flex flex-wrap gap-x-3 gap-y-1', militrinType.micro)}>
                {dateText ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Calendar size={12} className="text-slate-500" />
                    {dateKind === 'order' ? `Pedido em ${dateText}` : dateText}
                  </span>
                ) : null}
                {location ? (
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin size={12} className="text-slate-500" />{location}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {/* Informacoes / status operacional */}
        <div className="min-w-0 space-y-2.5 lg:border-l lg:border-slate-800/80 lg:pl-5">
          <p className={militrinType.body}>{summaryLine}</p>
          <div className="flex flex-wrap gap-1.5">
            <MilitrinBadge tone={chip.tone}>
              <span className="inline-flex items-center gap-1">
                <chip.icon size={11} />{chip.label}
              </span>
            </MilitrinBadge>
          </div>
        </div>

        {/* Valor e acoes */}
        <div className="flex flex-col gap-3 lg:items-end lg:border-l lg:border-slate-800/80 lg:pl-5 lg:text-right">
          <div>
            <p className={militrinType.label}>Valor final</p>
            <p className={cx('text-2xl', militrinType.money)}>{finalAmount}</p>
            {paymentMethod ? <p className={militrinType.micro}>Pagamento via {paymentMethod}</p> : null}
          </div>
          {expirationValue ? (
            <p className={cx('text-xs font-medium', expirationTone === 'danger' ? 'text-rose-300' : 'text-amber-200')}>
              {expirationLabel ?? 'Expira em'}<br />{expirationValue}
            </p>
          ) : null}
          {primaryAction || secondaryAction ? (
            <div className="flex w-full flex-col gap-2">
              {primaryAction}
              {secondaryAction}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
