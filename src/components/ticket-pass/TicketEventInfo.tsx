import { CalendarDays, Clock3, MapPin } from 'lucide-react';
import type { EventPassDateParts } from './ticket-pass-format';

type TicketEventInfoProps = {
  dateParts: EventPassDateParts | null;
  location?: string | null;
};

export function TicketEventInfo({ dateParts, location }: TicketEventInfoProps) {
  if (!dateParts && !location) return null;

  return (
    <section className="px-5 pt-6 sm:px-6">
      <div className="flex items-end gap-4">
        {dateParts ? (
          <div className="flex items-end gap-3">
            <CalendarDays size={18} strokeWidth={1.75} className="mb-1.5 shrink-0 text-(--brand-400)" aria-hidden />
            <p className="flex items-end gap-2.5">
              <span className="text-5xl font-semibold leading-none tracking-tight text-white tabular-nums">{dateParts.day}</span>
              <span className="pb-0.5">
                <span className="block text-sm font-semibold uppercase tracking-[0.22em] text-(--brand-300)">{dateParts.month}</span>
                <span className="block text-sm font-medium text-zinc-400">{dateParts.year}</span>
              </span>
            </p>
          </div>
        ) : null}

        {dateParts?.time ? (
          <p className="mb-0.5 inline-flex items-center gap-1.5 text-lg font-semibold tabular-nums text-zinc-100">
            <Clock3 size={16} strokeWidth={1.75} className="text-(--brand-400)" aria-hidden />
            <span>{dateParts.time}</span>
          </p>
        ) : null}
      </div>

      {location ? (
        <p className="mt-4 flex items-start gap-2 text-sm text-zinc-200">
          <MapPin size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-(--brand-400)" aria-hidden />
          <span>{location}</span>
        </p>
      ) : null}
    </section>
  );
}
