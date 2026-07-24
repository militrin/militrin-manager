export function LoadingState({ label = "Carregando..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center rounded-3xl border border-slate-800 bg-slate-900/50 p-8 text-sm text-slate-300">
      <span className="animate-pulse">{label}</span>
    </div>
  );
}
