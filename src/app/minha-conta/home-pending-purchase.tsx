import Link from 'next/link';
import { MilitrinLinkButton, cx, militrinType } from '@/components/militrin';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

export function HomePendingPurchase({
  orderId,
  eventName,
  quantity,
  categoryLabel,
  batchLabel,
  amount,
}: {
  orderId: string;
  eventName: string;
  quantity: number;
  categoryLabel: string | null;
  batchLabel: string | null;
  amount: number;
}) {
  const subtitle = [eventName, batchLabel || categoryLabel].filter(Boolean).join(' · ');

  return (
    <section className="flex h-full flex-col justify-between rounded-[1.25rem] border border-amber-500/30 bg-gradient-to-br from-slate-900/90 to-amber-950/20 p-3 shadow-lg shadow-black/10 sm:rounded-[1.5rem] sm:p-4 lg:h-auto lg:flex-row lg:items-center lg:gap-4 lg:p-3">
      <div className="min-w-0 lg:flex-1">
        <div className="flex items-center justify-between gap-2 lg:justify-start lg:gap-3">
          <p className={cx('uppercase tracking-[0.18em] text-amber-200', militrinType.label)}>Compra pendente</p>
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-200">
            Pendente
          </span>
        </div>
        <p className="mt-2 truncate text-sm font-semibold text-white lg:mt-1" title={subtitle}>
          {subtitle}
          {quantity > 1 ? ` · ${quantity} ingressos` : ''}
        </p>
        <p className={cx('mt-1 text-xl sm:text-2xl lg:text-lg', militrinType.money)}>{money(amount)}</p>
      </div>
      <div className="mt-3 flex items-center gap-3 lg:mt-0 lg:shrink-0">
        <MilitrinLinkButton href={`/minha-conta/compras/${orderId}`} size="sm" className="min-w-0 flex-1 lg:flex-none">
          Continuar pagamento
        </MilitrinLinkButton>
        <Link href={`/minha-conta/compras/${orderId}`} className="hidden shrink-0 text-xs font-medium text-slate-400 transition hover:text-slate-200 sm:inline">
          Ver detalhes →
        </Link>
      </div>
    </section>
  );
}
