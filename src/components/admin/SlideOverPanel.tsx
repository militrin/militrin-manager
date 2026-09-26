"use client";

import { useEffect } from "react";

type SlideOverPanelProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** No mobile vira bottom sheet; no desktop permanece drawer lateral. */
  mobileSheet?: boolean;
};

// Painel lateral generico para tirar formularios de criacao/edicao do fluxo
// principal da pagina (a lista/estrutura atual continua sendo o conteudo
// primario; o formulario só ocupa a tela quando o admin pede para criar/editar).
export function SlideOverPanel({ open, title, onClose, children, mobileSheet = false }: SlideOverPanelProps) {
  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 z-[60] flex bg-slate-950/70 ${
        mobileSheet ? "items-end p-0 lg:items-stretch lg:justify-end lg:p-4" : "justify-end p-0 sm:p-4"
      }`}
    >
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 cursor-default" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative flex w-full flex-col overflow-y-auto border-slate-700 bg-slate-900 p-5 shadow-2xl ${
          mobileSheet
            ? "max-h-[92dvh] rounded-t-2xl border-t pb-[calc(var(--mobile-bottomnav-h)+var(--safe-bottom)+0.75rem)] lg:h-full lg:max-h-none lg:max-w-lg lg:rounded-2xl lg:border lg:pb-5"
            : "h-full max-w-lg border-l sm:rounded-2xl sm:border"
        }`}
      >
        {mobileSheet ? (
          <div className="mb-3 flex justify-center lg:hidden" aria-hidden>
            <span className="h-1 w-10 rounded-full bg-slate-600" />
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <h3 className="min-w-0 truncate text-base font-semibold text-white">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 min-w-11 items-center justify-center rounded-lg border border-slate-700 px-3 text-xs text-slate-300 lg:h-auto lg:min-w-0 lg:py-1"
          >
            Fechar ✕
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
