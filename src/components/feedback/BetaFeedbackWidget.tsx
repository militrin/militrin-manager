'use client';

import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { FeedbackModal } from './FeedbackModal';

// Discreto de proposito: uma tira pequena, nunca um banner grande. So um
// ponto de entrada para o modal -- toda a logica de envio/contexto vive no
// FeedbackModal, para poder ser reaproveitado (ex.: uma futura area de
// suporte) sem duplicar nada.
export function BetaFeedbackWidget() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800/80 bg-slate-900/50 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--brand-500)/15 text-(--brand-300)">
            <FlaskConical size={14} />
          </span>
          <p className="min-w-0 text-xs text-slate-300">
            <span className="font-semibold text-slate-100">Militrin Beta.</span> Encontrou algum problema? Ajude-nos a melhorar.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 rounded-full border border-slate-700 bg-slate-950/60 px-3.5 py-1.5 text-xs font-semibold text-slate-100 transition hover:border-slate-500"
        >
          Reportar problema
        </button>
      </section>

      <FeedbackModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
