"use client";

import { useEffect } from "react";

type SlideOverPanelProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
};

// Painel lateral generico para tirar formularios de criacao/edicao do fluxo
// principal da pagina (a lista/estrutura atual continua sendo o conteudo
// primario; o formulario só ocupa a tela quando o admin pede para criar/editar).
export function SlideOverPanel({ open, title, onClose, children }: SlideOverPanelProps) {
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
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/70 p-0 sm:p-4">
      <button type="button" aria-label="Fechar" onClick={onClose} className="absolute inset-0 cursor-default" />
      <div className="relative flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-slate-700 bg-slate-900 p-5 shadow-2xl sm:rounded-2xl sm:border">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-white">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300">
            Fechar ✕
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
