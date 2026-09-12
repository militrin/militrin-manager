import Link from 'next/link';
import { ChevronRight, QrCode, ShoppingBag, Store, Ticket } from 'lucide-react';
import { cx, militrinType } from '@/components/militrin';

type QuickAction = {
  href: string;
  label: string;
  hint: string;
  icon: typeof QrCode;
};

export function HomeQuickActions({
  qrHref,
  hasAccessibleTicket,
  purchaseCount,
  activeTicketCount,
}: {
  qrHref: string;
  hasAccessibleTicket: boolean;
  purchaseCount: number;
  activeTicketCount: number;
}) {
  const secondary: QuickAction[] = [
    {
      href: '/minha-conta/ingressos',
      label: 'Meus acessos',
      hint: activeTicketCount === 1 ? '1 ingresso ativo' : `${activeTicketCount} ingressos ativos`,
      icon: Ticket,
    },
    {
      href: '/minha-conta/compras',
      label: 'Minhas compras',
      hint: purchaseCount === 1 ? '1 compra' : `${purchaseCount} compras`,
      icon: ShoppingBag,
    },
    {
      href: '/minha-conta/loja',
      label: 'Ir para a loja',
      hint: 'Produtos e adicionais',
      icon: Store,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Link
        href={qrHref}
        className="col-span-2 flex min-h-20 items-center gap-3 rounded-[1.5rem] border border-emerald-400/30 bg-emerald-500/12 px-4 py-3.5 shadow-lg shadow-black/20 transition hover:border-emerald-300/50 active:bg-emerald-500/18 sm:min-h-24"
      >
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-emerald-400/40 bg-slate-950 text-emerald-300 sm:h-16 sm:w-16">
          <QrCode size={28} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold text-white">Acessar meu QR Code</span>
          <span className={cx('mt-0.5 block', militrinType.micro)}>
            {hasAccessibleTicket ? 'Ver meu pacote e QR Code' : 'Abrir Meus acessos'}
          </span>
        </span>
        <ChevronRight size={18} className="shrink-0 text-emerald-200" />
      </Link>

      {secondary.map((action) => {
        const Icon = action.icon;
        return (
          <Link
            key={action.href}
            href={action.href}
            className="flex min-h-20 flex-col justify-center gap-2 rounded-[1.5rem] border border-slate-800/80 bg-slate-900/70 px-3.5 py-3 transition hover:border-slate-600 active:bg-slate-900 sm:min-h-24"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-950 text-emerald-300">
              <Icon size={18} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-white">{action.label}</span>
              <span className={cx('block truncate', militrinType.micro)}>{action.hint}</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
