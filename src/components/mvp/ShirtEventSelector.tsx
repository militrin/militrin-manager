'use client';

import { useRouter } from 'next/navigation';

type EventOption = {
  id: string;
  name: string;
  year: number | null;
  is_active: boolean;
};

type ShirtEventSelectorProps = {
  events: EventOption[];
  selectedEventId: string | null;
};

export function ShirtEventSelector({ events, selectedEventId }: ShirtEventSelectorProps) {
  const router = useRouter();

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-slate-400">Evento:</span>
      <select
        value={selectedEventId ?? ''}
        onChange={(event) => {
          const nextId = event.target.value;
          router.push(nextId ? `/camisetas?eventId=${encodeURIComponent(nextId)}` : '/camisetas');
        }}
        className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
      >
        <option value="">Selecione</option>
        {events.map((event) => (
          <option key={event.id} value={event.id}>
            {event.name}{event.year ? ` (${event.year})` : ''}{event.is_active ? ' - ativo' : ''}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => router.push('/camisetas')}
        className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200"
      >
        Limpar
      </button>
    </div>
  );
}