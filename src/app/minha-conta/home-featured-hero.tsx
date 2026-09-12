import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
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
  const eventHref = event.slug ? `/eventos/${event.slug}` : null;
  const whenLine = event.compactWhen || event.date;
  const mobileCta = eventHref ? { label: 'Ver evento', href: eventHref } : cta;

  return (
    <section className="overflow-hidden rounded-2xl border border-emerald-500/20 bg-slate-950/80 px-3 py-2.5 lg:px-4">
      <div className="flex items-center gap-3">
        <div className="relative hidden h-10 w-10 shrink-0 overflow-hidden rounded-xl bg-black ring-1 ring-(--brand-500)/40 lg:block">
          <div aria-hidden className="mask-logo absolute inset-1" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight text-white lg:text-base" title={title}>
              {title}
            </h2>
            <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-200 lg:hidden">
              Destaque
            </span>
          </div>
          {whenLine ? <p className="mt-0.5 truncate text-xs text-slate-300">{whenLine}</p> : null}
          <p className="truncate text-xs text-slate-400">{event.location}</p>
        </div>

        {cta ? (
          <Link
            href={cta.href}
            className="hidden h-11 shrink-0 items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-400 px-4 text-sm font-semibold text-emerald-950 lg:inline-flex"
          >
            {cta.label}
            <ChevronRight size={14} />
          </Link>
        ) : null}
      </div>

      {mobileCta ? (
        <Link
          href={mobileCta.href}
          className="mt-2 inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-400 px-4 text-sm font-semibold text-emerald-950 lg:hidden"
        >
          {mobileCta.label}
          <ChevronRight size={14} />
        </Link>
      ) : null}
    </section>
  );
}
