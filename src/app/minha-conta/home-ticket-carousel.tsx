'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Hash, MapPin, QrCode, Ticket, Users } from 'lucide-react';
import { MilitrinStatusBadge } from '@/components/militrin';
import type { AccountHomeTicketCard } from '@/lib/account/home-ticket-cards';

// 1 ingresso: card unico sem navegacao. 2+: carrossel com setas e indicadores
// (mesma experiencia visual para 2 ou 3+, so a quantidade de pontos muda).
export function HomeTicketCarousel({ tickets }: { tickets: AccountHomeTicketCard[] }) {
  const [index, setIndex] = useState(0);

  if (tickets.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 text-center text-sm text-slate-300">
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
        <div className="relative h-44 w-full bg-slate-900 sm:h-56">
          {current.bannerUrl ? (
            <Image src={current.bannerUrl} alt="" fill unoptimized className="object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-slate-600">Sem banner</div>
          )}
          <span className="absolute right-3 top-3">
            <MilitrinStatusBadge status={current.status} />
          </span>
        </div>

        <div className="p-4 sm:p-5">
          <h3 className="truncate text-lg font-semibold text-white sm:text-xl" title={current.eventName}>{current.eventName}</h3>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-300">
            {current.date ? (
              <span className="inline-flex items-center gap-1.5"><Calendar size={13} className="text-slate-500" />{current.date}</span>
            ) : null}
            {current.location ? (
              <span className="inline-flex items-center gap-1.5"><MapPin size={13} className="text-slate-500" />{current.location}</span>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {current.categoryLabel ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-200">
                <Users size={12} />{current.categoryLabel}
              </span>
            ) : null}
            {current.batchLabel ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs font-medium uppercase tracking-wide text-slate-200">
                <Ticket size={12} />{current.batchLabel}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs font-medium tracking-wide text-slate-400">
              <Hash size={12} />{current.codeLabel}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href={`/minha-conta/ingressos/${current.ticketId}`}
              className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-2xl border border-slate-700 bg-slate-900/70 px-4 text-sm font-semibold text-slate-100 transition hover:border-slate-500 sm:flex-none"
            >
              Ver ingresso
            </Link>
            {current.canShowTicket ? (
              <Link
                href={`/minha-conta/ingressos/${current.ticketId}`}
                className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-2xl border border-emerald-500/40 bg-emerald-500/15 px-4 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/25 sm:flex-none"
              >
                <QrCode size={15} />Abrir QR Code
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
              className="absolute left-3 top-20 flex h-9 w-9 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-slate-200 shadow-lg backdrop-blur transition hover:border-slate-500 sm:top-24"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              aria-label="Próximo ingresso"
              className="absolute right-3 top-20 flex h-9 w-9 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-slate-200 shadow-lg backdrop-blur transition hover:border-slate-500 sm:top-24"
            >
              <ChevronRight size={16} />
            </button>
          </>
        ) : null}
      </div>

      {hasMultiple ? (
        <div className="mt-3 flex items-center justify-center gap-1.5" role="tablist" aria-label="Selecionar ingresso">
          {tickets.map((ticket, dotIndex) => (
            <button
              key={ticket.ticketId}
              type="button"
              role="tab"
              aria-selected={dotIndex === index}
              aria-label={`Ver ingresso ${dotIndex + 1} de ${tickets.length}`}
              onClick={() => goTo(dotIndex)}
              className={`h-1.5 rounded-full transition-all ${dotIndex === index ? 'w-6 bg-(--brand-400)' : 'w-1.5 bg-slate-700 hover:bg-slate-600'}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
