'use client';

import { useMemo, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, MapPin, QrCode, Ticket, Users } from 'lucide-react';
import { LocalQrImage } from '@/components/qr/LocalQrImage';
import { MilitrinLinkButton, MilitrinStatusBadge, cx, militrinType } from '@/components/militrin';
import type { AccountHomeTicketCard } from '@/lib/account/home-ticket-cards';
import { buildCarouselDotTargets, findActiveDotIndex } from '@/lib/account/carousel-dots';

export function HomeTicketCarousel({
  tickets,
  emptyTitle,
  emptyDescription,
  emptyHref,
  emptyLabel,
}: {
  tickets: AccountHomeTicketCard[];
  emptyTitle?: string;
  emptyDescription?: string;
  emptyHref?: string;
  emptyLabel?: string;
}) {
  const [index, setIndex] = useState(0);
  const dotTargets = useMemo(() => buildCarouselDotTargets(tickets.length), [tickets.length]);
  const activeDotIndex = findActiveDotIndex(dotTargets, index);

  if (tickets.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5 text-center text-sm text-slate-300">
        <p>{emptyTitle ?? 'Você ainda não possui ingressos. Assim que uma compra for confirmada, ele aparece aqui.'}</p>
        {emptyDescription ? <p className="mt-2 text-xs text-slate-400">{emptyDescription}</p> : null}
        {emptyHref && emptyLabel ? (
          <MilitrinLinkButton href={emptyHref} variant="secondary" size="lg" className="mt-3 w-full sm:w-auto">
            {emptyLabel}
          </MilitrinLinkButton>
        ) : null}
      </div>
    );
  }

  const current = tickets[Math.min(index, tickets.length - 1)];
  const hasMultiple = tickets.length > 1;
  const qrHref = `/minha-conta/ingressos/${current.ticketId}#qr`;

  function goTo(nextIndex: number) {
    setIndex(((nextIndex % tickets.length) + tickets.length) % tickets.length);
  }

  return (
    <div>
      <div className="relative overflow-hidden rounded-[1.5rem] border border-slate-800 bg-slate-950/80">
        <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_180px] lg:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className={cx('truncate sm:text-lg', militrinType.cardTitle)} title={current.eventName}>{current.eventName}</h3>
              <MilitrinStatusBadge status={current.status} label={current.status === 'used' ? 'Usado' : 'Ativo'} />
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-300">
              {current.date ? (
                <span className="inline-flex items-center gap-1"><Calendar size={12} className="text-slate-500" />{current.date}</span>
              ) : null}
              {current.location ? (
                <span className="inline-flex items-center gap-1"><MapPin size={12} className="text-slate-500" />{current.location}</span>
              ) : null}
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:max-w-md">
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
                <dt className="uppercase tracking-[0.16em] text-slate-500">Titular</dt>
                <dd className="mt-0.5 truncate font-medium text-slate-100">{current.holderName || 'Não definido'}</dd>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
                <dt className="uppercase tracking-[0.16em] text-slate-500">Camiseta</dt>
                <dd className="mt-0.5 truncate font-medium text-slate-100">{current.shirtLabel || '—'}</dd>
              </div>
            </dl>

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
            </div>

            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {current.canShowTicket ? (
                <MilitrinLinkButton href={qrHref} variant="success" size="lg" iconLeft={<QrCode size={16} />} className="w-full sm:flex-1">
                  Abrir QR Code
                </MilitrinLinkButton>
              ) : null}
              <MilitrinLinkButton href={`/minha-conta/ingressos/${current.ticketId}`} variant="secondary" size="lg" className="w-full sm:flex-1">
                Ver acesso
              </MilitrinLinkButton>
            </div>
          </div>

          {current.canShowTicket && current.token ? (
            <div className="hidden w-[180px] shrink-0 flex-col items-center lg:flex">
              <div className="rounded-2xl bg-white p-2 shadow-lg">
                <LocalQrImage
                  value={current.token}
                  alt="QR Code do acesso Militrin"
                  size={168}
                  className="h-[168px] w-[168px] bg-white"
                />
              </div>
              <p className="mt-2 hidden text-center text-[10px] uppercase tracking-[0.14em] text-slate-500 xl:block">
                Apresente no ponto de retirada
              </p>
            </div>
          ) : null}
        </div>

        {hasMultiple ? (
          <>
            <button
              type="button"
              onClick={() => goTo(index - 1)}
              aria-label="Ingresso anterior"
              className="absolute left-2 top-3 flex h-11 w-11 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-slate-200 shadow-lg backdrop-blur transition hover:border-slate-500"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={() => goTo(index + 1)}
              aria-label="Próximo ingresso"
              className="absolute right-2 top-3 flex h-11 w-11 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-slate-200 shadow-lg backdrop-blur transition hover:border-slate-500"
            >
              <ChevronRight size={18} />
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
              className={`h-2.5 min-w-2.5 rounded-full transition-all ${dotIndex === activeDotIndex ? 'w-7 bg-(--brand-400)' : 'w-2.5 bg-slate-700 hover:bg-slate-600'}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
