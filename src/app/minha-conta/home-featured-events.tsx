import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { MilitrinEventArtwork, cx } from '@/components/militrin';

export type HomeFeaturedEvent = {
  id: string;
  name: string;
  year: number | null;
  date: string;
  compactDate: string;
  location: string;
  bannerUrl: string | null;
  registrationStatus: string;
  soldPercent: number | null;
  startingPrice: string | null;
  eventHref: string;
  isHot: boolean;
};

export function HomeFeaturedEvents({ events }: { events: HomeFeaturedEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 snap-x snap-mandatory [scrollbar-width:none] lg:mx-0 lg:grid lg:grid-cols-2 lg:overflow-visible lg:px-0 lg:pb-0 lg:snap-none xl:grid-cols-3 [&::-webkit-scrollbar]:hidden">
      {events.map((event) => {
        const title = event.year ? `${event.name} ${event.year}` : event.name;
        return (
          <Link
            key={event.id}
            href={event.eventHref}
            className="w-[min(78vw,280px)] shrink-0 snap-start overflow-hidden rounded-[1.5rem] border border-slate-800/80 bg-slate-950/70 shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:border-emerald-500/40 hover:shadow-emerald-950/20 lg:w-auto"
          >
            <MilitrinEventArtwork src={event.bannerUrl} alt="" hideWhenEmpty={false} emptyLabel="Militrin">
              {event.isHot ? (
                <span className="absolute right-2.5 top-2.5 rounded-full bg-emerald-500/90 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow">
                  Em alta
                </span>
              ) : null}
            </MilitrinEventArtwork>
            <div className="p-3.5">
              <h3 className="truncate text-base font-semibold text-white" title={title}>{title}</h3>
              <p className="mt-1 truncate text-sm text-slate-400">{event.compactDate}</p>
              <p className="truncate text-sm text-slate-400">{event.location}</p>
              <span className={cx('mt-3 inline-flex h-11 items-center text-sm font-semibold text-emerald-200')}>
                Ver evento
                <ChevronRight size={14} className="ml-1" />
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
