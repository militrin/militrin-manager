"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

export type AdministrativeEventOption = { id: string; name: string; is_active?: boolean };

export function EventContextSelector({ events, selectedEventId, pathname, allowAll = false, allLabel = "Todos os eventos" }: {
  events: AdministrativeEventOption[];
  selectedEventId: string | null;
  pathname: string;
  allowAll?: boolean;
  allLabel?: string;
}) {
  const searchParams = useSearchParams();

  function eventHref(eventId: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (eventId) params.set("eventId", eventId);
    else params.delete("eventId");
    params.delete("page");
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Contexto do evento</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {allowAll ? <Link href={eventHref("")}
          className={`rounded-lg border px-3 py-1.5 text-sm ${selectedEventId === null ? "border-emerald-400 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-300"}`}>
          {allLabel}
        </Link> : null}
        {events.map((event) => (
          <Link key={event.id} href={eventHref(event.id)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${selectedEventId === event.id ? "border-emerald-400 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-300"}`}>
            {event.name}{event.is_active ? " · Ativo" : ""}
          </Link>
        ))}
      </div>
      {!selectedEventId && !allowAll ? <p className="mt-2 text-sm text-amber-200">Selecione um evento para continuar.</p> : null}
    </div>
  );
}
