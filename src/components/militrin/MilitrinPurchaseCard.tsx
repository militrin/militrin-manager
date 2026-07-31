import type { ReactNode } from 'react';
import { MilitrinCard } from './MilitrinCard';
import { MilitrinStatusBadge } from './MilitrinStatusBadge';

type MilitrinPurchaseCardProps = {
  orderNumber: string;
  eventName: string;
  date: string;
  finalAmount: string;
  quantity?: number;
  subtitle?: string | null;
  paymentMethod: string;
  paymentStatus: string;
  orderStatus: string;
  expiration?: string | null;
  actions?: ReactNode;
};

export function MilitrinPurchaseCard({
  orderNumber,
  eventName,
  date,
  finalAmount,
  quantity,
  subtitle,
  paymentMethod,
  paymentStatus,
  orderStatus,
  expiration,
  actions,
}: MilitrinPurchaseCardProps) {
  return (
    <MilitrinCard className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Pedido {orderNumber}</p>
          <h3 className="mt-1 text-xl font-semibold text-white">{eventName}</h3>
          {typeof quantity === 'number' ? <p className="mt-1 text-xs text-slate-300">{quantity} ingresso(s)</p> : null}
          {subtitle ? <p className="mt-1 text-xs text-slate-400">{subtitle}</p> : null}
        </div>
        <MilitrinStatusBadge status={orderStatus} />
      </div>

      <div className="mt-4 grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
        <p>Data: {date}</p>
        <p>Valor final: {finalAmount}</p>
        <p>Pagamento: {paymentMethod}</p>
        <p>Status pagamento: {paymentStatus}</p>
      </div>

      {expiration ? <p className="mt-2 text-xs text-amber-200">Expira em: {expiration}</p> : null}
      {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
    </MilitrinCard>
  );
}
