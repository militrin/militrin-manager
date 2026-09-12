import Link from 'next/link';
import { CalendarDays, ChevronRight, MapPin } from 'lucide-react';
import { cx } from '@/components/militrin';
import type { MilitrinHeaderEvent } from '@/components/militrin/MilitrinHeader';
import type { HomeFeaturedEventCta } from '@/lib/account/home-ticket-cta';

export function HomeFeaturedHero({
  event,
  cta,
}: {
  event: MilitrinHeaderEvent;
  cta: HomeFeaturedEventCta | null;
}) {
  const title = event.year ? `${event.name} ${event.year}` : event.name;

  return (
    <section className="relative isolate overflow-hidden rounded-[1.75rem] border border-emerald-500/20 bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950/40 p-4 shadow-lg shadow-black/30 sm:rounded-[2rem] sm:p-5 lg:p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,_var(--brand-glow-strong),_transparent_42%)]" />
      <div aria-hidden className="mask-logo pointer-events-none absolute -right-6 -top-8 h-44 w-44 rotate-6 opacity-[0.12] sm:h-56 sm:w-56" />

      <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl bg-black ring-1 ring-(--brand-500)/40 shadow-lg shadow-(--brand-600)/20 sm:h-20 sm:w-20">
            <div aria-hidden className="mask-logo absolute inset-1" />
          </div>
          <div className="min-w-0">
            <p className="inline-flex items-center rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-200">
              Evento em destaque
            </p>
            <h2 className="mt-2 truncate text-xl font-semibold tracking-tight text-white sm:text-2xl" title={title}>
              {title}
            </h2>
            <div className="mt-2 flex flex-col gap-1.5 text-sm text-slate-200">
              <p className="inline-flex items-start gap-2">
                <CalendarDays size={16} className="mt-0.5 shrink-0 text-emerald-300" />
                <span className="min-w-0">
                  <span className="block font-medium text-white">{event.date}</span>
                  {event.schedule ? <span className="block text-xs text-slate-400">{event.schedule}</span> : null}
                </span>
              </p>
              <p className="inline-flex items-start gap-2">
                <MapPin size={16} className="mt-0.5 shrink-0 text-emerald-300" />
                <span className="min-w-0 font-medium text-white">{event.location}</span>
              </p>
            </div>
          </div>
        </div>

        {cta ? (
          <Link
            href={cta.href}
            className={cx(
              'inline-flex h-12 w-full shrink-0 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-400 px-5 text-sm font-semibold text-emerald-950 shadow-lg shadow-emerald-600/25 sm:h-12 lg:w-auto lg:min-w-[220px]',
            )}
          >
            {cta.label}
            <ChevronRight size={16} />
          </Link>
        ) : null}
      </div>
    </section>
  );
}
