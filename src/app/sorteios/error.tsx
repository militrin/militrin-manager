"use client";

export default function SorteiosError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-100">
      <p className="font-semibold">Não foi possível carregar os sorteios agora.</p>
      <p className="mt-2 text-rose-200/80">Tente novamente. Se o problema continuar, recarregue a página.</p>
      <button type="button" onClick={reset} className="mt-4 rounded-xl bg-white/10 px-4 py-2 text-xs font-semibold">
        Tentar novamente
      </button>
      {error.digest ? <p className="mt-3 text-[11px] text-rose-300/70">Código {error.digest}</p> : null}
    </div>
  );
}
