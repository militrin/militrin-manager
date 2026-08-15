import Link from 'next/link';
import { ShoppingBag } from 'lucide-react';
import { MilitrinCard } from './MilitrinCard';
import { MilitrinButton } from './MilitrinButton';

type MilitrinEventCardProps = {
  events: Array<{
    id: string;
    name: string;
    date: string;
    location: string;
    registrationStatus: string;
    startingPrice?: string | null;
    buyHref: string;
  }>;
};

export function MilitrinEventCard({ events }: MilitrinEventCardProps) {
  const visibleEvents = events.slice(0, 2);

  return (
    <MilitrinCard className="p-5">
      <p className="text-xs uppercase tracking-[0.2em] text-(--brand-300)">Eventos em destaque!</p>

      {visibleEvents.length > 0 ? (
        <div className="mt-3 space-y-3">
          {visibleEvents.map((event) => (
            <div key={event.id} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
              <h3 className="line-clamp-2 text-xl font-semibold text-white" title={event.name}>{event.name}</h3>
              <p className="mt-2 text-sm text-slate-300">{event.date}</p>
              <p className="text-sm text-slate-300">{event.location}</p>
              <p className="mt-2 text-xs uppercase tracking-wide text-slate-400">Venda: {event.registrationStatus}</p>
              {event.startingPrice ? <p className="mt-1 text-sm text-(--brand-200)">Preço inicial: {event.startingPrice}</p> : null}
              <Link href={event.buyHref} className="mt-3 inline-flex">
                <MilitrinButton size="sm" iconLeft={<ShoppingBag size={13} />}>Comprar ingresso</MilitrinButton>
              </Link>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-300">Nenhum evento em destaque no momento.</p>
      )}

      <div className="mt-4">
        <Link href="/eventos">
          <MilitrinButton variant="secondary" size="sm">Ver todos os eventos!</MilitrinButton>
        </Link>
      </div>
    </MilitrinCard>
  );
}
