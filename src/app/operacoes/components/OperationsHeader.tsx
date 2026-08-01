"use client";

export function OperationsHeader() {
  return (
    <header className="flex flex-col gap-4 rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.28em] text-emerald-400">
          Operação em tempo real de credenciamento, kits, pulseiras e acesso
        </p>
        <h1 className="text-2xl font-semibold text-white">Central de Operações</h1>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled
          className="rounded-2xl border border-slate-700 px-4 py-2 text-sm text-slate-500"
        >
          Modo Turbo (em breve)
        </button>
      </div>
    </header>
  );
}
