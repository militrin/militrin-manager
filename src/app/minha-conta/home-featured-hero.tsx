import Image from 'next/image';
import Link from 'next/link';
import { CalendarDays, ChevronRight, Clock3, MapPin } from 'lucide-react';
import { cx } from '@/components/militrin';
import type { MilitrinHeaderEvent } from '@/components/militrin/MilitrinHeader';
import type { HomeFeaturedEventCta } from '@/lib/account/home-ticket-cta';

function HopWatermark({ className }: { className: string }) {
  return (
    <svg aria-hidden viewBox="0 0 64 88" className={className} fill="currentColor">
      <path d="M32 2C20 10 14 22 16 34c-6 2-10 8-10 15 0 9 8 16 18 16 3 0 6-1 9-2 3 1 6 2 9 2 10 0 18-7 18-16 0-7-4-13-10-15 2-12-4-24-16-32 1 5 0 10-2 14-2-4-3-9-2-14Zm-9 34c1 4 5 7 9 7s8-3 9-7c-3 2-6 3-9 3s-6-1-9-3Zm-3 12c1 3 4 5 7 5s6-2 7-5c-2 1-5 2-7 2s-5-1-7-2Zm18 0c1 3 4 5 7 5s6-2 7-5c-2 1-5 2-7 2s-5-1-7-2Z" />
    </svg>
  );
}

function heroDateLabel(date: string) {
  return date.replace(/\s+de\s+\d{4}$/, '');
}

function heroHoursLabel(event: MilitrinHeaderEvent) {
  if (event.schedule?.includes('•')) {
    return event.schedule.split('•')[1]?.trim() || null;
  }
  if (!event.compactWhen) return null;
  const parts = event.compactWhen.split(' · ');
  return parts[1] ?? null;
}

const ctaClassName = 'h-8 shrink-0 items-center justify-center gap-1 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-400 px-3 text-[11px] font-semibold text-emerald-950 shadow-lg shadow-emerald-600/25 transition hover:from-emerald-400 hover:to-emerald-300 sm:h-10 sm:rounded-2xl sm:px-4 sm:text-sm lg:h-11 lg:px-5';

export function HomeFeaturedHero({
  event,
  cta,
}: {
  event: MilitrinHeaderEvent;
  cta: HomeFeaturedEventCta | null;
}) {
  const title = event.year ? `${event.name} ${event.year}` : event.name;
  const dateLabel = heroDateLabel(event.date);
  const hoursLabel = heroHoursLabel(event);
  const hasBanner = Boolean(event.imageUrl);

  return (
    <section
      className={cx(
        'relative isolate overflow-hidden rounded-[1.25rem] border border-emerald-500/25 bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950/35 shadow-lg shadow-emerald-950/20',
        'h-[168px] sm:h-[176px] sm:rounded-[1.5rem] lg:h-[188px]',
      )}
    >
      {hasBanner ? (
        <>
          <Image
            src={event.imageUrl as string}
            alt=""
            fill
            unoptimized
            aria-hidden
            sizes="100vw"
            className="scale-125 object-cover blur-2xl"
          />
          <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-slate-950/90 via-slate-950/75 to-slate-950/45" />
        </>
      ) : (
        <>
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,_var(--brand-glow-strong),_transparent_42%),radial-gradient(circle_at_bottom_left,_var(--brand-glow-2),_transparent_55%)]" />
          <HopWatermark className="pointer-events-none absolute -right-3 -top-8 h-28 w-20 rotate-12 text-emerald-400 opacity-[0.10] lg:h-40 lg:w-28" />
          <div aria-hidden className="mask-logo pointer-events-none absolute -right-6 bottom-[-30%] hidden h-32 w-32 opacity-[0.08] lg:block" />
        </>
      )}

      <div className="relative flex h-full items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 sm:gap-4 sm:px-4 sm:py-3 lg:gap-5 lg:px-5 lg:py-4">
          <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl bg-black ring-1 ring-emerald-400/40 shadow-lg shadow-emerald-600/20 sm:h-16 sm:w-16 lg:h-[4.75rem] lg:w-[4.75rem]">
            <div aria-hidden className="mask-logo absolute inset-1 sm:inset-1.5" />
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-emerald-300 sm:text-[11px]">Evento em destaque</p>
            <h2 className="mt-0.5 truncate text-base font-semibold tracking-tight text-white sm:text-xl lg:text-2xl" title={title}>
              {title}
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-slate-300 lg:hidden">{dateLabel}</p>
            <ul className="mt-1.5 hidden gap-x-4 gap-y-0.5 text-sm text-slate-200 lg:flex lg:flex-wrap">
              <li className="inline-flex min-w-0 items-center gap-1.5">
                <CalendarDays size={14} className="shrink-0 text-emerald-300" />
                <span className="truncate">{dateLabel}</span>
              </li>
              {hoursLabel ? (
                <li className="inline-flex min-w-0 items-center gap-1.5">
                  <Clock3 size={14} className="shrink-0 text-emerald-300" />
                  <span className="truncate">{hoursLabel}</span>
                </li>
              ) : null}
              {event.location ? (
                <li className="inline-flex min-w-0 items-center gap-1.5">
                  <MapPin size={14} className="shrink-0 text-emerald-300" />
                  <span className="truncate">{event.location}</span>
                </li>
              ) : null}
            </ul>
            {cta ? (
              <Link href={cta.href} className={cx(ctaClassName, 'mt-1.5 inline-flex lg:hidden')}>
                {cta.label}
                <ChevronRight size={14} />
              </Link>
            ) : null}
          </div>

          {cta ? (
            <Link href={cta.href} className={cx(ctaClassName, 'hidden lg:inline-flex')}>
              {cta.label}
              <ChevronRight size={14} />
            </Link>
          ) : null}
        </div>

        {hasBanner ? (
          <div className="relative h-full w-[38%] max-w-[17.5rem] shrink-0">
            <div className="absolute inset-1.5 sm:inset-2">
              <Image
                src={event.imageUrl as string}
                alt=""
                fill
                unoptimized
                sizes="(max-width: 1024px) 40vw, 280px"
                className="object-contain object-center"
              />
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
