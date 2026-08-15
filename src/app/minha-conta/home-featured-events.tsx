import Image from 'next/image';
import Link from 'next/link';
import { Calendar, MapPin, ShoppingBag, Star } from 'lucide-react';

export type HomeFeaturedEvent = {
  id: string;
  name: string;
  date: string;
  location: string;
  bannerUrl: string | null;
  registrationStatus: string;
  soldPercent: number | null;
  startingPrice: string | null;
  buyHref: string;
};

export function HomeFeaturedEvents({ events }: { events: HomeFeaturedEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-slate-300">Nenhum evento em destaque no momento.</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {events.map((event) => (
        <article key={event.id} className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/60">
          <div className="relative h-32 w-full bg-slate-900">
            {event.bannerUrl ? (
              <Image src={event.bannerUrl} alt="" fill unoptimized className="object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-slate-600">Sem banner</div>
            )}
            <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-(--brand-500)/90 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow">
              <Star size={10} fill="currentColor" />Em alta
            </span>
          </div>

          <div className="p-4">
            <h3 className="truncate text-base font-semibold text-white" title={event.name}>{event.name}</h3>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
              <span className="inline-flex items-center gap-1"><Calendar size={11} />{event.date}</span>
              <span className="inline-flex items-center gap-1"><MapPin size={11} />{event.location}</span>
            </div>

            {event.soldPercent !== null ? (
              <div className="mt-3">
                <p className="text-[11px] font-medium text-emerald-300">{event.soldPercent}% vendidos</p>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.min(100, event.soldPercent)}%` }} />
                </div>
              </div>
            ) : (
              <p className="mt-3 text-[11px] uppercase tracking-wide text-slate-500">Vendas {event.registrationStatus}</p>
            )}

            <div className="mt-3 flex items-center justify-between gap-2">
              {event.startingPrice ? (
                <p className="text-xs text-slate-400">A partir de<br /><span className="text-sm font-semibold text-slate-100">{event.startingPrice}</span></p>
              ) : <span />}
              <Link
                href={event.buyHref}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/25"
              >
                <ShoppingBag size={13} />Comprar ingresso
              </Link>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
