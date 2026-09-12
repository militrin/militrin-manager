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
    <section className="flex h-full flex-col rounded-[1.5rem] border border-amber-500/30 bg-gradient-to-br from-slate-900/90 to-amber-950/20 p-4 shadow-lg shadow-black/10">
      <div className="flex items-center justify-between gap-2">
        <p className={cx('uppercase tracking-[0.18em] text-amber-200', militrinType.label)}>Compra pendente</p>
        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-200">
          Pendente
        </span>
      </div>
      <p className="mt-3 truncate text-base font-semibold text-white" title={subtitle}>
        {subtitle}
        {quantity > 1 ? ` · ${quantity} ingressos` : ''}
      </p>
      <p className={cx('mt-2 text-2xl', militrinType.money)}>{money(amount)}</p>
      <MilitrinLinkButton href={`/minha-conta/compras/${orderId}`} size="md" className="mt-4 w-full">
        Continuar pagamento
      </MilitrinLinkButton>
      <Link href={`/minha-conta/compras/${orderId}`} className="mt-2 inline-flex text-sm font-medium text-slate-400 transition hover:text-slate-200">
        Ver detalhes →
      </Link>
    </section>
  );
}
