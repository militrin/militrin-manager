import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
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

function heroHoursLabel(compactWhen?: string | null) {
  if (!compactWhen) return null;
  const parts = compactWhen.split(' · ');
  return parts[1] ?? null;
}

export function HomeFeaturedHero({
  event,
  cta,
}: {
  event: MilitrinHeaderEvent;
  cta: HomeFeaturedEventCta | null;
}) {
  const title = event.year ? `${event.name} ${event.year}` : event.name;
  const dateLabel = heroDateLabel(event.date);
  const hoursLabel = heroHoursLabel(event.compactWhen);
  const mobileWhen = event.compactWhen || [dateLabel, hoursLabel].filter(Boolean).join(' · ');

  return (
    <section className="relative isolate overflow-hidden rounded-[1.5rem] border border-emerald-500/25 bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950/35 p-4 shadow-lg shadow-emerald-950/20 sm:p-5 lg:min-h-[132px] lg:px-6 lg:py-5">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,_var(--brand-glow-strong),_transparent_42%),radial-gradient(circle_at_bottom_left,_var(--brand-glow-2),_transparent_55%)]" />
      <HopWatermark className="pointer-events-none absolute -right-3 -top-8 h-36 w-28 rotate-12 text-emerald-400 opacity-[0.10] lg:h-44 lg:w-32" />
      <div aria-hidden className="mask-logo pointer-events-none absolute -right-8 bottom-[-28%] hidden h-40 w-40 opacity-[0.08] lg:block" />

      <div className="relative flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl bg-black ring-1 ring-emerald-400/40 shadow-lg shadow-emerald-600/20 sm:h-16 sm:w-16">
            <div aria-hidden className="mask-logo absolute inset-1.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-300">Evento em destaque</p>
              <span className="rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-200 lg:hidden">
                Destaque
              </span>
            </div>
            <h2 className="mt-1 truncate text-xl font-semibold tracking-tight text-white sm:text-2xl" title={title}>
              {title}
            </h2>
            <p className="mt-1 hidden text-sm text-slate-200 lg:block">
              {dateLabel}
              {hoursLabel ? <span className="text-slate-400"> · {hoursLabel}</span> : null}
            </p>
            <p className="mt-0.5 truncate text-sm text-slate-300 lg:hidden">{mobileWhen}</p>
            <p className="mt-0.5 truncate text-sm text-slate-400">{event.location}</p>
          </div>
        </div>

        {cta ? (
          <Link
            href={cta.href}
            className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-400 px-5 text-sm font-semibold text-emerald-950 shadow-lg shadow-emerald-600/25 transition hover:from-emerald-400 hover:to-emerald-300 lg:w-auto"
          >
            {cta.label}
            <ChevronRight size={16} />
          </Link>
        ) : null}
      </div>
    </section>
  );
}
