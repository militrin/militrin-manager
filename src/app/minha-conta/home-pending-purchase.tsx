import { MilitrinLinkButton, MilitrinStatusBadge, cx, militrinType } from '@/components/militrin';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

export function HomePendingPurchase({
  orderId,
  eventName,
  quantity,
  categoryLabel,
  batchLabel,
  date,
  location,
  amount,
}: {
  orderId: string;
  eventName: string;
  quantity: number;
  categoryLabel: string | null;
  batchLabel: string | null;
  date: string | null;
  location: string | null;
  amount: number;
}) {
  return (
    <section className="rounded-[1.75rem] border border-amber-500/25 bg-slate-900/70 p-4 shadow-lg shadow-black/10 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className={cx('flex items-center gap-2', militrinType.sectionTitle)}>Compra pendente</h2>
        <MilitrinStatusBadge status="pending" label="Pendente" />
      </div>
      <div className="mt-4 space-y-2">
        <p className={militrinType.cardTitle}>{eventName}</p>
        <div className={cx('flex flex-wrap gap-x-4 gap-y-1', militrinType.micro)}>
          {date ? <span>{date}</span> : null}
          {location ? <span>{location}</span> : null}
        </div>
        <p className={militrinType.body}>
          {quantity} ingresso{quantity === 1 ? '' : 's'}
          {categoryLabel ? ` • ${categoryLabel}` : ''}
        </p>
        {batchLabel ? <p className={militrinType.micro}>{batchLabel}</p> : null}
        <p className={cx('pt-1 text-2xl', militrinType.money)}>{money(amount)}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <MilitrinLinkButton href={`/minha-conta/compras/${orderId}`} size="lg" className="w-full sm:flex-1">
            Continuar pagamento
          </MilitrinLinkButton>
          <MilitrinLinkButton href={`/minha-conta/compras/${orderId}`} variant="secondary" size="lg" className="w-full sm:flex-1">
            Ver detalhes
          </MilitrinLinkButton>
        </div>
      </div>
    </section>
  );
}
