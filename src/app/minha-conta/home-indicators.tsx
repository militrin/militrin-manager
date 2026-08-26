import type { ReactNode } from 'react';
import { Crown, ShoppingBag, Ticket } from 'lucide-react';
import { militrinType } from '@/components/militrin';

type IndicatorItem = {
  icon: ReactNode;
  iconClassName: string;
  value: ReactNode;
  label: string;
};

function Indicator({ icon, iconClassName, value, label }: IndicatorItem) {
  return (
    <div className="flex flex-1 items-center gap-2.5 px-3.5 py-2.5 sm:px-4">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconClassName}`}>{icon}</span>
      <div className="min-w-0">
        <p className={`truncate leading-tight ${militrinType.value}`}>{value}</p>
        <p className={`truncate leading-tight ${militrinType.micro}`}>{label}</p>
      </div>
    </div>
  );
}

// Faixa compacta (nao cards altos): Compras | Ingressos ativos | Categoria.
// Categoria usa o nivel de fidelidade real (mesma fonte de /minha-conta/nivel).
// Um 4o indicador "Nível" (fixo em "Em breve") foi removido daqui -- a Home
// nao deve reservar espaco pra uma funcionalidade que ainda nao existe.
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
    <div className="flex flex-col divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-950/60 sm:flex-row sm:divide-x sm:divide-y-0">
      <Indicator
        icon={<ShoppingBag size={15} className="text-(--brand-300)" />}
        iconClassName="bg-(--brand-500)/15"
        value={purchaseCount}
        label="Compras"
      />
      <Indicator
        icon={<Ticket size={15} className="text-emerald-300" />}
        iconClassName="bg-emerald-500/15"
        value={activeTicketCount}
        label="Ingressos ativos"
      />
      <Indicator
        icon={<Crown size={15} className="text-amber-300" />}
        iconClassName="bg-amber-500/15"
        value={categoryName}
        label="Categoria"
      />
    </div>
  );
}
