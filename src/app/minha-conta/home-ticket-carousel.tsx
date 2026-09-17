'use client';

import { CalendarDays, MapPin, QrCode, Shirt, User } from 'lucide-react';
import Link from 'next/link';
import { LocalQrImage } from '@/components/qr/LocalQrImage';
import { MilitrinLinkButton, cx, militrinType } from '@/components/militrin';
import type { AccountHomeTicketCard } from '@/lib/account/home-ticket-cards';
import { PublicPinCopy } from './public-pin-copy';

function shirtLine(ticket: AccountHomeTicketCard) {
  const shirt = ticket.shirtLabel ? ticket.shirtLabel.replace(/^camiseta\s+/i, '') : null;
  const parts = [shirt, ticket.batchLabel].filter(Boolean);
  return parts.length > 0 ? `Camiseta ${parts.join(' · ')}` : null;
}

function AccessFrame({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-[1.25rem] border border-emerald-500/20 bg-gradient-to-br from-slate-900/90 to-slate-950 p-3 shadow-lg shadow-black/10 sm:rounded-[1.5rem] sm:p-4">
      {children}
    </section>
  );
}

function MobileAccessPin({ publicPin }: { publicPin: string | null }) {
  if (!publicPin) return null;
  return (
    <div className="lg:hidden">
      <PublicPinCopy publicPin={publicPin} compact />
    </div>
  );
}

export function HomeTicketCarousel({
  tickets,
  publicPin = null,
  emptyTitle,
  emptyDescription,
  emptyHref,
  emptyLabel,
}: {
  tickets: AccountHomeTicketCard[];
  publicPin?: string | null;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyHref?: string;
  emptyLabel?: string;
}) {
  if (tickets.length === 0) {
    return (
      <AccessFrame>
        <p className={cx('uppercase tracking-[0.18em] text-emerald-300', militrinType.label)}>Meu acesso</p>
        <p className="mt-2 text-sm text-slate-300">{emptyTitle ?? 'Você ainda não possui ingressos.'}</p>
        {emptyDescription ? <p className="mt-1 text-xs text-slate-400">{emptyDescription}</p> : null}
        <MobileAccessPin publicPin={publicPin} />
        {emptyHref && emptyLabel ? (
          <MilitrinLinkButton href={emptyHref} variant="secondary" size="sm" className="mt-3 w-full sm:w-auto">
            {emptyLabel}
          </MilitrinLinkButton>
        ) : null}
      </AccessFrame>
    );
  }

  if (tickets.length > 1) {
    return (
      <AccessFrame>
        <div className="flex items-center justify-between gap-2">
          <p className={cx('uppercase tracking-[0.18em] text-emerald-300', militrinType.label)}>Meus acessos</p>
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200">
            {tickets.length} ativos
          </span>
        </div>
        <p className="mt-2 text-sm text-slate-300">Você tem {tickets.length} ingressos ativos.</p>
        <MobileAccessPin publicPin={publicPin} />
        <MilitrinLinkButton href="/minha-conta/ingressos" variant="success" size="sm" className="mt-3 w-full">
          Ver meus acessos
        </MilitrinLinkButton>
      </AccessFrame>
    );
  }

  const current = tickets[0];
  const qrHref = `/minha-conta/ingressos/${current.ticketId}#qr`;
  const detailsHref = `/minha-conta/ingressos/${current.ticketId}`;
  const details = shirtLine(current);
  const primaryHref = current.canShowTicket ? qrHref : detailsHref;
  const primaryLabel = current.canShowTicket ? 'Abrir QR Code' : 'Ver acesso';

  return (
    <AccessFrame>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className={cx('uppercase tracking-[0.18em] text-emerald-300', militrinType.label)}>Meu acesso</p>
          <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200">
            {current.status === 'used' ? 'Usado' : 'Ativo'}
          </span>
        </div>
        {tickets.length > 1 ? (
          <MilitrinLinkButton href="/minha-conta/ingressos" variant="ghost" size="sm" className="hidden h-8 px-2 text-xs text-emerald-200 lg:inline-flex">
            Ver todos os acessos
          </MilitrinLinkButton>
        ) : null}
      </div>

      <div className="mt-2.5 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-white sm:text-base" title={current.eventName}>
            {current.eventName}
          </h3>
          {current.date ? (
            <p className="mt-1 hidden truncate text-xs text-slate-400 lg:flex lg:items-center lg:gap-1.5">
              <CalendarDays size={12} className="shrink-0 text-emerald-300" />
              <span className="truncate">{current.date}</span>
            </p>
          ) : null}
          <p className="mt-1 truncate text-xs text-slate-200">
            <span className="inline-flex max-w-full items-center gap-1.5">
              <User size={12} className="shrink-0 text-emerald-300" />
              <span className="truncate">Titular: {current.holderName || 'Não definido'}</span>
            </span>
          </p>
          {current.ticketCode ? (
            <p className="mt-0.5 font-mono text-[11px] tracking-[0.08em] text-slate-400">
              Código do ingresso {current.ticketCode}
            </p>
          ) : null}
          {details ? (
            <p className="mt-0.5 truncate text-xs text-slate-300">
              <span className="inline-flex max-w-full items-center gap-1.5">
                <Shirt size={12} className="shrink-0 text-emerald-300" />
                <span className="truncate">{details}</span>
              </span>
            </p>
          ) : null}
          {current.location ? (
            <p className="mt-0.5 hidden truncate text-xs text-slate-400 lg:flex lg:items-center lg:gap-1.5">
              <MapPin size={12} className="shrink-0 text-emerald-300" />
              <span className="truncate">{current.location}</span>
            </p>
          ) : null}

          <MobileAccessPin publicPin={publicPin} />

          <div className="mt-3 flex items-center gap-2">
            <MilitrinLinkButton
              href={primaryHref}
              prefetch={false}
              variant="success"
              size="sm"
              iconLeft={current.canShowTicket ? <QrCode size={14} /> : undefined}
              className="w-auto"
            >
              {primaryLabel}
            </MilitrinLinkButton>
            {current.canShowTicket ? (
              <Link
                href={detailsHref}
                prefetch={false}
                className="hidden h-9 items-center justify-center rounded-2xl border border-slate-700 bg-slate-900/70 px-3 text-xs font-semibold text-slate-100 transition hover:border-slate-500 lg:inline-flex"
              >
                Ver acesso
              </Link>
            ) : null}
          </div>
        </div>

        {current.canShowTicket && current.token ? (
          <div className="shrink-0 rounded-xl bg-white p-1 shadow-lg shadow-black/30">
            <LocalQrImage
              value={current.token}
              alt="QR Code do acesso Militrin"
              size={96}
              className="h-[76px] w-[76px] bg-white lg:h-[96px] lg:w-[96px]"
            />
          </div>
        ) : null}
      </div>
    </AccessFrame>
  );
}
