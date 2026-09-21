import Image from 'next/image';
import Link from 'next/link';
import { CalendarDays, ChevronRight, MapPin } from 'lucide-react';
import { cx } from '@/components/militrin/utils';
import type { EventDiscoveryCard } from '@/lib/public/event-discovery';

function EventArtwork({ src, children }: { src: string | null; children?: React.ReactNode }) {
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

function statusTone(status: EventDiscoveryCard['status']) {
  if (status === 'open') return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200';
  if (status === 'ended') return 'border-slate-600 bg-slate-800/80 text-slate-300';
  return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
}

export function AccountEventDiscoveryGrid({ events }: { events: EventDiscoveryCard[] }) {
  if (events.length === 0) {
    return (
      <p className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 text-sm text-slate-300">
        Nenhum evento publicado no momento.
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {events.map((event) => (
        <article
          key={event.id}
          className="flex flex-col overflow-hidden rounded-[1.15rem] border border-slate-800/80 bg-slate-950/70 shadow-lg shadow-black/10"
        >
          <EventArtwork src={event.bannerUrl}>
            <span className={cx('absolute left-2 top-2 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide', statusTone(event.status))}>
              {event.statusLabel}
            </span>
          </EventArtwork>
          <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
            <h2 className="truncate text-sm font-semibold text-white sm:text-base" title={event.title}>{event.title}</h2>
            <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-slate-400">
              <CalendarDays size={11} className="shrink-0 text-emerald-300" />
              <span className="truncate">{event.date}</span>
            </p>
            <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-slate-400">
              <MapPin size={11} className="shrink-0 text-emerald-300" />
              <span className="truncate">{event.location}</span>
            </p>
            {event.footnote ? <p className="mt-2 text-[11px] leading-snug text-amber-200">{event.footnote}</p> : null}
            <div className="mt-3 flex flex-col gap-2">
              {event.status === 'open' && event.buyHref ? (
                <>
                  <Link
                    href={event.buyHref}
                    prefetch={false}
                    className="inline-flex h-10 items-center justify-center rounded-xl bg-emerald-400 px-3 text-xs font-semibold text-slate-950 transition hover:bg-emerald-300"
                  >
                    Comprar ingresso
                    <ChevronRight size={13} className="ml-1" />
                  </Link>
                  <Link
                    href={event.eventHref}
                    prefetch={false}
                    className="inline-flex h-9 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 text-xs font-semibold text-emerald-200"
                  >
                    Ver evento
                  </Link>
                </>
              ) : event.status === 'ended' ? (
                <span className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/40 text-xs font-semibold text-slate-400">
                  Evento encerrado
                </span>
              ) : (
                <Link
                  href={event.eventHref}
                  prefetch={false}
                  className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 text-xs font-semibold text-emerald-200"
                >
                  Ver evento
                  <ChevronRight size={13} className="ml-1" />
                </Link>
              )}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
