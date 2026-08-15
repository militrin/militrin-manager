'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

type EventOption = { id: string; name: string };

export function DashboardEventSelector({ events, selectedId }: { events: EventOption[]; selectedId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-2">
      <select
        value={selectedId}
        onChange={(e) => {
          const params = new URLSearchParams(searchParams.toString());
          params.set('eventId', e.target.value);
          startTransition(() => {
            router.push(`/painel?${params.toString()}`);
          });
        }}
        className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
      >
        <option value="all">Todos os eventos</option>
        {events.map((event) => (
          <option key={event.id} value={event.id}>{event.name}</option>
        ))}
      </select>
      {isPending ? <span className="text-xs text-slate-400">Atualizando...</span> : null}
    </div>
  );
}
