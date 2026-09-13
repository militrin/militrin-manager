import Image from 'next/image';
import Link from 'next/link';
import { CalendarDays, ChevronRight, MapPin } from 'lucide-react';
import { cx } from '@/components/militrin';

export type HomeFeaturedEvent = {
  id: string;
  name: string;
  year: number | null;
  date: string;
  compactDate: string;
  weekday: string | null;
  location: string;
  bannerUrl: string | null;
  registrationStatus: string;
  soldPercent: number | null;
  startingPrice: string | null;
  eventHref: string;
  isHot: boolean;
  isFeatured: boolean;
};

function HomeEventArtwork({
  src,
  children,
}: {
  src: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative flex w-full items-center justify-center bg-slate-950">
      {src ? (
        <Image
          src={src}
          alt=""
          width={1600}
          height={900}
          unoptimized
          className="mx-auto h-auto max-h-[11rem] w-auto max-w-full object-contain lg:max-h-[12.5rem]"
        />
      ) : (
        <div className="flex h-24 w-full items-center justify-center text-xs text-slate-600">Militrin</div>
      )}
      {children}
    </div>
  );
}

function EventCard({ event, fullWidth }: { event: HomeFeaturedEvent; fullWidth: boolean }) {
  const title = event.year ? `${event.name} ${event.year}` : event.name;
  const when = [event.date, event.weekday].filter(Boolean).join(' · ');

  return (
    <Link
      href={event.eventHref}
      className={cx(
        'flex shrink-0 snap-start flex-col overflow-hidden rounded-[1.15rem] border border-slate-800/80 bg-slate-950/70 shadow-lg shadow-black/10 transition hover:-translate-y-0.5 hover:border-emerald-500/40 hover:shadow-emerald-950/20 lg:h-full lg:w-full',
        fullWidth ? 'w-full' : 'w-[min(72vw,230px)]',
      )}
    >
      <HomeEventArtwork src={event.bannerUrl}>
        {event.isFeatured ? (
          <span className="absolute left-2 top-2 rounded-full bg-emerald-500/95 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow">
            Em destaque
          </span>
        ) : event.isHot ? (
          <span className="absolute right-2 top-2 rounded-full bg-emerald-500/90 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow">
            Em alta
          </span>
        ) : null}
      </HomeEventArtwork>
      <div className="flex min-h-0 flex-1 flex-col px-2.5 py-2 sm:px-3 sm:py-2.5">
        <h3 className="truncate text-sm font-semibold text-white" title={title}>{title}</h3>
        <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-slate-400">
          <CalendarDays size={11} className="shrink-0 text-emerald-300" />
          <span className="truncate">{when || event.compactDate}</span>
        </p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-slate-400">
          <MapPin size={11} className="shrink-0 text-emerald-300" />
          <span className="truncate">{event.location}</span>
        </p>
        <span className={cx('mt-2 inline-flex h-8 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 text-xs font-semibold text-emerald-200')}>
          Ver evento
          <ChevronRight size={13} className="ml-1" />
        </span>
      </div>
    </Link>
  );
}

export function HomeFeaturedEvents({ events }: { events: HomeFeaturedEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1 snap-x snap-mandatory [scrollbar-width:none] lg:mx-0 lg:grid lg:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] lg:overflow-visible lg:px-0 lg:pb-0 lg:snap-none [&::-webkit-scrollbar]:hidden">
      {events.map((event) => (
        <EventCard key={event.id} event={event} fullWidth={events.length === 1} />
      ))}
    </div>
  );
}
