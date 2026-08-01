'use client';

import type { OperationEvent } from '../types';

export function TurboMode({ event, onExit }: { event: OperationEvent; onExit: () => void }) {
  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-slate-950 text-slate-100">
      <div className="mx-auto min-h-screen max-w-4xl p-4 sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-cyan-300">Modo Operacional Turbo</p>
            <h1 className="text-3xl font-black">{event.name}</h1>
          </div>
          <button type="button" onClick={onExit} className="rounded-2xl border border-slate-700 px-5 py-3 font-semibold">
            Sair
          </button>
        </div>

        <div className="mt-8 rounded-3xl border border-slate-700 bg-slate-900 p-6 text-slate-300">
          Modo turbo indisponível nesta versão.
        </div>
      </div>
    </div>
  );
}
