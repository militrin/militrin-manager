"use client";

import { SlideOverPanel } from "@/components/admin/SlideOverPanel";
import { INSTAGRAM_HANDLE, PRIZE_NAME } from "./types";

type RulesDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function RulesDialog({ open, onClose }: RulesDialogProps) {
  return (
    <SlideOverPanel open={open} onClose={onClose} title="Regras do sorteio">
      <div className="space-y-5 text-sm text-slate-300">
        <section className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">O(a) ganhador(a) leva</p>
          <p className="mt-1 text-lg font-semibold text-white">{PRIZE_NAME}</p>
        </section>

        <section>
          <h4 className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Como participar</h4>
          <ol className="mt-2 space-y-3">
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-emerald-300">1</span>
              <span>Seguir {INSTAGRAM_HANDLE}</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-emerald-300">2</span>
              <span>Curtir a foto oficial do sorteio</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-emerald-300">3</span>
              <span>Marcar 2 amigos nos comentários. Quanto mais comentar, mais chances de ganhar.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-emerald-300">4</span>
              <span>Compartilhar o post oficial nos Stories, marcando {INSTAGRAM_HANDLE}.</span>
            </li>
          </ol>
        </section>

        <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
          O perfil deverá estar aberto no dia do sorteio.
        </p>

        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
          <p className="font-semibold uppercase tracking-[0.12em]">Importante</p>
          <p className="mt-1 leading-5">
            As condições de seguir, curtir e compartilhar nos Stories não podem ser consideradas automaticamente
            verificadas pelo sistema. Elas serão verificadas manualmente após o sorteio.
          </p>
        </section>
      </div>
    </SlideOverPanel>
  );
}
