import type { ReactNode } from 'react';
import { Crown, ShoppingBag, Ticket, Trophy } from 'lucide-react';

type IndicatorItem = {
  icon: ReactNode;
  iconClassName: string;
  value: ReactNode;
  label: string;
};

function Indicator({ icon, iconClassName, value, label }: IndicatorItem) {
  return (
    <div className="flex flex-1 items-center gap-3 px-4 py-3 sm:px-5">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${iconClassName}`}>{icon}</span>
      <div className="min-w-0">
        <p className="truncate text-lg font-semibold text-white leading-tight">{value}</p>
        <p className="truncate text-xs text-slate-400 leading-tight">{label}</p>
      </div>
    </div>
  );
}

// Faixa compacta (nao cards altos): Compras | Ingressos ativos | Categoria | Nível.
// Categoria usa o nivel de fidelidade real (mesma fonte de /minha-conta/nivel);
// Nível continua "Em breve" por nao existir um sistema separado ainda -- e essa
// e a UNICA linha da Home onde esse texto aparece.
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
        icon={<ShoppingBag size={17} className="text-(--brand-300)" />}
        iconClassName="bg-(--brand-500)/15"
        value={purchaseCount}
        label="Compras"
      />
      <Indicator
        icon={<Ticket size={17} className="text-emerald-300" />}
        iconClassName="bg-emerald-500/15"
        value={activeTicketCount}
        label="Ingressos ativos"
      />
      <Indicator
        icon={<Crown size={17} className="text-amber-300" />}
        iconClassName="bg-amber-500/15"
        value={categoryName}
        label="Categoria"
      />
      <Indicator
        icon={<Trophy size={17} className="text-purple-300" />}
        iconClassName="bg-purple-500/15"
        value={<span className="text-emerald-300">Em breve</span>}
        label="Nível"
      />
    </div>
  );
}
