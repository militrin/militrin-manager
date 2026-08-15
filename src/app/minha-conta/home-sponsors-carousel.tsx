'use client';

import Image from 'next/image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export type HomeSponsor = {
  id: string;
  name: string;
  bannerUrl: string;
};

// Pausa a rotacao automatica por um tempo apos qualquer interacao manual
// (seta ou indicador), depois retoma sozinha -- nunca fica parada para
// sempre so porque o usuario tocou uma vez.
const RESUME_AFTER_MANUAL_MS = 8000;

export function HomeSponsorsCarousel({ sponsors, intervalSeconds }: { sponsors: HomeSponsor[]; intervalSeconds: number }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMultiple = sponsors.length > 1;
  const intervalMs = Math.max(2, intervalSeconds) * 1000;

  const current = sponsors[Math.min(index, Math.max(sponsors.length - 1, 0))];

  useEffect(() => () => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!hasMultiple || paused) return;
    const timer = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % sponsors.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [hasMultiple, paused, intervalMs, sponsors.length]);

  const dotTargets = useMemo(() => sponsors.map((_, dotIndex) => dotIndex), [sponsors]);

  function pauseThenResume() {
    setPaused(true);
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => setPaused(false), RESUME_AFTER_MANUAL_MS);
  }

  function goTo(nextIndex: number) {
    setIndex(((nextIndex % sponsors.length) + sponsors.length) % sponsors.length);
    pauseThenResume();
  }

  if (!current) return null;

  return (
    <div>
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
        <Image src={current.bannerUrl} alt={current.name} fill unoptimized className="object-cover" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
          <p className="truncate text-xs font-semibold text-white/90">{current.name}</p>
        </div>

        {hasMultiple ? (
          <>
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              aria-label="Patrocinador anterior"
              className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-slate-200 shadow-lg backdrop-blur transition hover:border-slate-500"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              aria-label="Próximo patrocinador"
              className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-slate-200 shadow-lg backdrop-blur transition hover:border-slate-500"
            >
              <ChevronRight size={15} />
            </button>
          </>
        ) : null}
      </div>

      {hasMultiple ? (
        <div className="mt-2.5 flex items-center justify-center gap-1.5" role="tablist" aria-label="Selecionar patrocinador">
          {dotTargets.map((dotIndex) => (
            <button
              key={sponsors[dotIndex].id}
              type="button"
              role="tab"
              aria-selected={dotIndex === index}
              aria-label={`Ver patrocinador ${dotIndex + 1} de ${sponsors.length}`}
              onClick={() => goTo(dotIndex)}
              className={`h-1.5 rounded-full transition-all ${dotIndex === index ? 'w-6 bg-(--brand-400)' : 'w-1.5 bg-slate-700 hover:bg-slate-600'}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
