import Link from 'next/link';
import { Calendar, MapPin, Star } from 'lucide-react';
import { MilitrinEventArtwork, cx, militrinType } from '@/components/militrin';

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
    return <p className={militrinType.bodyMuted}>Nenhum evento publicado no momento.</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {events.map((event) => (
        <Link
          key={event.id}
          href={event.buyHref}
          className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/60 transition hover:border-slate-600"
        >
          <MilitrinEventArtwork src={event.bannerUrl}>
            {event.isHot ? (
              <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-(--brand-500)/90 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white shadow">
                <Star size={10} fill="currentColor" />Em alta
              </span>
            ) : event.registrationStatus === 'abertas' ? (
              <span className="absolute right-2.5 top-2.5 inline-flex items-center rounded-full bg-slate-950/80 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-200 shadow">
                Vendas abertas
              </span>
            ) : null}
          </MilitrinEventArtwork>

          <div className="p-4">
            <h3 className={cx('truncate', militrinType.cardTitle)} title={event.name}>{event.name}</h3>
            <div className={cx('mt-1 flex flex-wrap gap-x-3 gap-y-1', militrinType.micro)}>
              <span className="inline-flex items-center gap-1"><Calendar size={11} />{event.date}</span>
              <span className="inline-flex items-center gap-1"><MapPin size={11} />{event.location}</span>
            </div>
            {event.startingPrice ? (
              <p className="mt-3 text-xs text-slate-400">A partir de <span className={cx('text-sm', militrinType.money)}>{event.startingPrice}</span></p>
            ) : null}
          </div>
        </Link>
      ))}
    </div>
  );
}
