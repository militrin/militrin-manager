'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Hash, MapPin, QrCode, Ticket, Users } from 'lucide-react';
import { MilitrinStatusBadge } from '@/components/militrin';
import type { AccountHomeTicketCard } from '@/lib/account/home-ticket-cards';
import { buildCarouselDotTargets, findActiveDotIndex } from '@/lib/account/carousel-dots';

// 1 ingresso: card unico sem navegacao. 2+: carrossel com setas. Sempre
// mostra exatamente 1 ingresso por vez (nunca todos empilhados), independente
// da quantidade total -- os indicadores tambem nunca crescem 1:1 com a
// quantidade: no maximo ~5, representando a posicao, nunca virando poluicao
// visual com muitos ingressos (ver buildCarouselDotTargets).
export function HomeTicketCarousel({ tickets }: { tickets: AccountHomeTicketCard[] }) {
  const [index, setIndex] = useState(0);
  const dotTargets = useMemo(() => buildCarouselDotTargets(tickets.length), [tickets.length]);
  const activeDotIndex = findActiveDotIndex(dotTargets, index);

  if (tickets.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 text-center text-sm text-slate-300">
        Você ainda não possui ingressos. Assim que uma compra for confirmada, ele aparece aqui.
      </div>
    );
  }

  const current = tickets[Math.min(index, tickets.length - 1)];
  const hasMultiple = tickets.length > 1;

  function goTo(nextIndex: number) {
    setIndex(((nextIndex % tickets.length) + tickets.length) % tickets.length);
  }

  return (
    <div>
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
        <div className="relative h-36 w-full bg-slate-900 sm:h-40">
          {current.bannerUrl ? (
            <Image src={current.bannerUrl} alt="" fill unoptimized className="object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-slate-600">Sem banner</div>
          )}
          <span className="absolute right-2.5 top-2.5">
            <MilitrinStatusBadge status={current.status} />
          </span>
        </div>

        <div className="p-3.5 sm:p-4">
          <h3 className="truncate text-base font-semibold text-white sm:text-lg" title={current.eventName}>{current.eventName}</h3>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-300">
            {current.date ? (
              <span className="inline-flex items-center gap-1"><Calendar size={12} className="text-slate-500" />{current.date}</span>
            ) : null}
            {current.location ? (
              <span className="inline-flex items-center gap-1"><MapPin size={12} className="text-slate-500" />{current.location}</span>
            ) : null}
          </div>

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {current.categoryLabel ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-200">
                <Users size={11} />{current.categoryLabel}
              </span>
            ) : null}
            {current.batchLabel ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-200">
                <Ticket size={11} />{current.batchLabel}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-slate-400">
              <Hash size={11} />{current.codeLabel}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={`/minha-conta/ingressos/${current.ticketId}`}
              className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900/70 px-3 text-xs font-semibold text-slate-100 transition hover:border-slate-500 sm:flex-none"
            >
              Ver ingresso
            </Link>
            {current.canShowTicket ? (
              <Link
                href={`/minha-conta/ingressos/${current.ticketId}`}
                className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-3 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/25 sm:flex-none"
              >
                <QrCode size={14} />Abrir QR Code
              </Link>
            ) : null}
          </div>
        </div>

        {hasMultiple ? (
          <>
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              aria-label="Ingresso anterior"
              className="absolute left-2.5 top-14 flex h-8 w-8 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-slate-200 shadow-lg backdrop-blur transition hover:border-slate-500 sm:top-16"
            >
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              aria-label="Próximo ingresso"
              className="absolute right-2.5 top-14 flex h-8 w-8 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-slate-200 shadow-lg backdrop-blur transition hover:border-slate-500 sm:top-16"
            >
              <ChevronRight size={15} />
            </button>
          </>
        ) : null}
      </div>

      {hasMultiple ? (
        <p className="mt-2 text-center text-[11px] font-medium tracking-wide text-slate-500" aria-live="polite">
          <span aria-hidden="true">{index + 1} / {tickets.length}</span>
          <span className="sr-only">{`Ingresso ${index + 1} de ${tickets.length}`}</span>
        </p>
      ) : null}

      {hasMultiple ? (
        <div className="mt-1.5 flex items-center justify-center gap-1.5" role="tablist" aria-label="Selecionar ingresso">
          {dotTargets.map((targetIndex, dotIndex) => (
            <button
              key={targetIndex}
              type="button"
              role="tab"
              aria-selected={dotIndex === activeDotIndex}
              aria-label={`Ir para ingresso próximo da posição ${dotIndex + 1} de ${dotTargets.length}`}
              onClick={() => goTo(targetIndex)}
              className={`h-1.5 rounded-full transition-all ${dotIndex === activeDotIndex ? 'w-6 bg-(--brand-400)' : 'w-1.5 bg-slate-700 hover:bg-slate-600'}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
