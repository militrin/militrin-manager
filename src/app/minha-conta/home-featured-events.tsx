import Link from 'next/link';
import { cx, militrinType } from '@/components/militrin';

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
  isHot: boolean;
};

export function HomeFeaturedEvents({ events }: { events: HomeFeaturedEvent[] }) {
  if (events.length === 0) {
    return null;
  }

  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 snap-x snap-mandatory lg:mx-0 lg:grid lg:grid-cols-2 lg:overflow-visible lg:px-0 lg:pb-0 lg:snap-none">
      {events.map((event) => (
        <Link
          key={event.id}
          href={event.buyHref}
          className="w-[min(78vw,280px)] shrink-0 snap-start rounded-2xl border border-slate-800 bg-slate-950/60 p-3 transition hover:border-slate-600 lg:w-auto"
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className={cx('min-w-0 truncate text-sm font-semibold text-white')} title={event.name}>{event.name}</h3>
            {event.isHot ? (
              <span className="shrink-0 rounded-full bg-(--brand-500)/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                Em alta
              </span>
            ) : event.registrationStatus === 'abertas' ? (
              <span className="shrink-0 rounded-full bg-slate-950/80 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200">
                Aberto
              </span>
            ) : null}
          </div>
          <p className={cx('mt-1 truncate', militrinType.micro)}>
            {event.date} · {event.location}
          </p>
          {event.startingPrice ? (
            <p className="mt-1.5 text-xs text-slate-400">A partir de <span className={cx('text-sm', militrinType.money)}>{event.startingPrice}</span></p>
          ) : null}
        </Link>
      ))}
    </div>
  );
}
