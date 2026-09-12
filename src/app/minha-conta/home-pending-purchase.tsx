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
    <section className="rounded-2xl border border-amber-500/25 bg-slate-900/70 p-3">
      <p className={cx('uppercase tracking-[0.16em]', militrinType.label)}>Compra pendente</p>
      <p className="mt-2 truncate text-sm font-semibold text-white" title={subtitle}>
        {subtitle}
        {quantity > 1 ? ` · ${quantity} ingressos` : ''}
      </p>
      <p className={cx('mt-1 text-base', militrinType.money)}>{money(amount)}</p>
      <MilitrinLinkButton href={`/minha-conta/compras/${orderId}`} size="md" className="mt-3 w-full">
        Continuar pagamento
      </MilitrinLinkButton>
      <Link href={`/minha-conta/compras/${orderId}`} className="mt-2 inline-block text-xs font-medium text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline">
        Ver detalhes
      </Link>
    </section>
  );
}
