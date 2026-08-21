"use client";

/**
 * Popup generico pra QUALQUER erro de operacao disparada por botao manual na
 * ficha/linha (Entregar itens, Fazer check-in, Entregar + check-in, item
 * adicional, etc.). Mesmo padrao visual de ReasonDialog/WristbandCodeModal
 * -- so leitura, um unico botao "Fechar". Nao substitui o banner global
 * (message/OperationsDashboard); e um complemento local e imediato pra quem
 * disparou a acao.
 */
export function OperationalErrorDialog({
  title,
  message,
  details,
  onClose,
}: {
  title: string;
  message: string;
  details?: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="operational-error-title"
        className="w-full max-w-sm rounded-t-3xl border border-rose-500/30 bg-slate-950 p-5 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="operational-error-title" className="text-base font-semibold text-rose-100">
          {title}
        </h3>
        <p className="mt-2 text-sm text-slate-300" role="alert">{message}</p>
        {details ? <p className="mt-2 text-xs text-slate-500">{details}</p> : null}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="h-10 rounded-xl bg-rose-500 px-4 text-sm font-semibold text-rose-950"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
