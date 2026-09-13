'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export type HomeSponsor = {
  id: string;
  name: string;
  bannerUrl: string;
  linkUrl: string | null;
};

function SponsorSlide({ sponsor }: { sponsor: HomeSponsor }) {
  const [ratio, setRatio] = useState<number | null>(null);

  const tile = (
    <div
      className="relative w-full overflow-hidden [aspect-ratio:var(--sponsor-ratio)] lg:aspect-auto lg:h-full"
      style={{ ['--sponsor-ratio' as string]: String(ratio ?? 4 / 3) }}
    >
      <Image
        src={sponsor.bannerUrl}
        alt={sponsor.name}
        fill
        unoptimized
        sizes="(max-width: 1024px) 92vw, 480px"
        onLoad={(event) => {
          const img = event.currentTarget;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            setRatio(img.naturalWidth / img.naturalHeight);
          }
        }}
        className="object-contain object-center"
      />
    </div>
  );

  if (!sponsor.linkUrl) return tile;

  return (
    <a
      href={sponsor.linkUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Visitar site de ${sponsor.name}`}
      className="block w-full lg:h-full"
    >
      {tile}
    </a>
  );
}

export function HomeSponsorsCarousel({
  sponsors,
  intervalSeconds = 4,
}: {
  sponsors: HomeSponsor[];
  intervalSeconds?: number;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const count = sponsors.length;

  const go = useCallback((direction: number) => {
    setIndex((current) => (current + direction + count) % count);
  }, [count]);

  useEffect(() => {
    if (count < 2 || paused || intervalSeconds < 1) return undefined;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (media.matches) return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % count);
    }, intervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [count, paused, intervalSeconds]);

  if (count === 0) return null;

  const current = sponsors[index] ?? sponsors[0];

  return (
    <section
      className="relative flex w-full flex-col rounded-[1.25rem] border border-slate-800/80 bg-slate-950/80 p-3 shadow-lg shadow-black/10 sm:rounded-[1.5rem] lg:h-full lg:min-h-[11.5rem]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={(event) => {
        touchStartX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        const start = touchStartX.current;
        const end = event.changedTouches[0]?.clientX;
        touchStartX.current = null;
        if (start == null || end == null || count < 2) return;
        const delta = end - start;
        if (Math.abs(delta) < 40) return;
        go(delta < 0 ? 1 : -1);
      }}
    >
      <h2 className="text-sm font-semibold text-white sm:text-base">Patrocinadores</h2>
      <div className="relative mt-2 w-full lg:min-h-0 lg:flex-1">
        <SponsorSlide sponsor={current} />

        {count > 1 ? (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              className="absolute left-2 top-1/2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-slate-950/70 text-white transition hover:bg-slate-900 lg:inline-flex"
              aria-label="Patrocinador anterior"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              className="absolute right-2 top-1/2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-slate-950/70 text-white transition hover:bg-slate-900 lg:inline-flex"
              aria-label="Próximo patrocinador"
            >
              <ChevronRight size={16} />
            </button>
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center gap-1.5">
              {sponsors.map((sponsor, sponsorIndex) => (
                <button
                  key={sponsor.id}
                  type="button"
                  aria-label={`Mostrar patrocinador ${sponsor.name}`}
                  onClick={() => setIndex(sponsorIndex)}
                  className={`pointer-events-auto h-1.5 rounded-full transition ${sponsorIndex === index ? 'w-4 bg-emerald-300' : 'w-1.5 bg-white/35'}`}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
