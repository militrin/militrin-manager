"use client";

import { useRouter } from "next/navigation";

type EventOption = { id: string; name: string; year: number | null; is_active: boolean };

export function StoreEventSelector({ events, selectedEventId }: { events: EventOption[]; selectedEventId: string | null }) {
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={selectedEventId ?? ""}
        onChange={(e) => {
          const nextId = e.target.value;
          router.push(nextId ? `/loja?eventId=${encodeURIComponent(nextId)}` : "/loja");
        }}
        className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
      >
        <option value="">Todos os eventos</option>
        {events.map((event) => (
          <option key={event.id} value={event.id}>
            {event.name}{event.year ? ` (${event.year})` : ""}{event.is_active ? " - ativo" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
