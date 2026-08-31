"use client";

import { useEffect, useRef, useState } from "react";
import type { ParticipationEntry } from "./types";

const ITEM_WIDTH = 220;
const REEL_LENGTH = 46;
const DURATION_MS = 5000;

type ReelItem = { key: string; username: string; isWinner: boolean };

function buildReel(pool: ParticipationEntry[], winner: ParticipationEntry): ReelItem[] {
  const decoysSource = pool.length > 0 ? pool : [winner];
  const decoys: ReelItem[] = Array.from({ length: REEL_LENGTH - 1 }, (_, i) => {
    const candidate = decoysSource[Math.floor(Math.random() * decoysSource.length)];
    return { key: `decoy-${i}`, username: candidate.username, isWinner: false };
  });
  return [...decoys, { key: "winner", username: winner.username, isWinner: true }];
}

type RouletteAnimationProps = {
  pool: ParticipationEntry[];
  winner: ParticipationEntry;
  onComplete: () => void;
};

export function RouletteAnimation({ pool, winner, onComplete }: RouletteAnimationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [reel] = useState(() => buildReel(pool, winner));
  const [translateX, setTranslateX] = useState(0);
  const [transitioning, setTransitioning] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerWidth = container.offsetWidth;
    const winnerIndex = reel.length - 1;
    const target = -(winnerIndex * ITEM_WIDTH + ITEM_WIDTH / 2 - containerWidth / 2);

    const raf = requestAnimationFrame(() => {
      setTransitioning(true);
      setTranslateX(target);
    });

    const timeout = setTimeout(onComplete, DURATION_MS + 150);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="text-center">
        <p className="text-lg font-semibold tracking-wide text-emerald-300">SORTEANDO...</p>
        <p className="mt-1 text-sm text-slate-400">Boa sorte a todos! 🍀</p>
      </div>

      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/80 py-8"
      >
        <div className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-[3px] -translate-x-1/2 bg-emerald-400 shadow-[0_0_16px_2px_rgba(52,211,153,0.6)]" />
        <div className="pointer-events-none absolute inset-0 z-[5] bg-gradient-to-r from-slate-950 via-transparent to-slate-950" />

        <div
          className="flex items-center"
          style={{
            transform: `translateX(${translateX}px)`,
            transition: transitioning ? `transform ${DURATION_MS}ms cubic-bezier(0.1, 0.82, 0.18, 1)` : "none",
          }}
        >
          {reel.map((item) => (
            <div
              key={item.key}
              className="flex shrink-0 items-center justify-center"
              style={{ width: ITEM_WIDTH }}
            >
              <span className="truncate rounded-xl border border-slate-800 bg-slate-900/80 px-4 py-3 text-base font-medium text-slate-200">
                @{item.username}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-2 w-2 animate-pulse rounded-full bg-emerald-400"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
