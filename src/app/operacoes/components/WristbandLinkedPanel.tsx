"use client";

/**
 * Bloco operacional padrao da pulseira ativa. Nao some so porque o requisito
 * de check-in/kit ja foi satisfeito -- o operador precisa ver o codigo e,
 * com permissao, descobrir "Substituir pulseira" sem saber o nome da RPC.
 */
export function WristbandLinkedPanel({
  code,
  canReplace,
  onReplace,
  compact,
}: {
  code: string;
  canReplace?: boolean;
  onReplace?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "space-y-1" : "space-y-2"}>
      <p className={compact ? "text-[11px] text-slate-400" : "text-xs uppercase tracking-wide text-slate-500"}>
        Pulseira vinculada
      </p>
      <p className={`font-mono font-semibold text-cyan-100 ${compact ? "text-[12px] leading-tight" : "text-sm"}`}>
        {code}
      </p>
      {canReplace && onReplace ? (
        <button
          type="button"
          onClick={onReplace}
          className={
            compact
              ? "rounded-lg border border-cyan-500/40 px-2 py-1 text-[11px] font-semibold text-cyan-200"
              : "rounded-lg border border-cyan-500/40 px-3 py-1.5 text-xs font-semibold text-cyan-200"
          }
        >
          Substituir pulseira
        </button>
      ) : null}
    </div>
  );
}
