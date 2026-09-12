import type { ReactNode } from 'react';
import Link from 'next/link';
import { Crown, ShoppingBag, Ticket } from 'lucide-react';
import { militrinType } from '@/components/militrin';

type IndicatorItem = {
  href: string;
  icon: ReactNode;
  iconClassName: string;
  value: ReactNode;
  label: string;
};

function Indicator({ href, icon, iconClassName, value, label }: IndicatorItem) {
  return (
    <Link
      href={href}
      className="flex min-h-20 flex-1 flex-col justify-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/60 px-3.5 py-3 transition hover:border-slate-600 sm:px-4"
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${iconClassName}`}>{icon}</span>
      <div className="min-w-0">
        <p className={`truncate leading-tight ${militrinType.value}`}>{value}</p>
        <p className={`truncate leading-tight ${militrinType.micro}`}>{label}</p>
      </div>
    </Link>
  );
}

export function HomeIndicators({
  purchaseCount,
  activeTicketCount,
  categoryName,
}: {
  purchaseCount: number;
  activeTicketCount: number;
  categoryName: string;
}) {
  return (
    <section>
      <h2 className={militrinType.sectionTitle}>Seus números</h2>
      <div className="mt-3 grid grid-cols-3 gap-2.5 sm:gap-3">
        <Indicator
          href="/minha-conta/compras"
          icon={<ShoppingBag size={15} className="text-(--brand-300)" />}
          iconClassName="bg-(--brand-500)/15"
          value={purchaseCount}
          label="Compras"
        />
        <Indicator
          href="/minha-conta/ingressos"
          icon={<Ticket size={15} className="text-emerald-300" />}
          iconClassName="bg-emerald-500/15"
          value={activeTicketCount}
          label="Ingressos ativos"
        />
        <Indicator
          href="/minha-conta/nivel"
          icon={<Crown size={15} className="text-amber-300" />}
          iconClassName="bg-amber-500/15"
          value={categoryName}
          label="Categoria"
        />
      </div>
    </section>
  );
}
