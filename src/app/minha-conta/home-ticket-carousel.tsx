'use client';

import { QrCode } from 'lucide-react';
import { LocalQrImage } from '@/components/qr/LocalQrImage';
import { MilitrinLinkButton, cx, militrinType } from '@/components/militrin';
import type { AccountHomeTicketCard } from '@/lib/account/home-ticket-cards';

function metaLine(ticket: AccountHomeTicketCard) {
  return [ticket.date, ticket.location].filter(Boolean).join(' · ');
}

function shirtLine(ticket: AccountHomeTicketCard) {
  const parts = [ticket.shirtLabel, ticket.batchLabel].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

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
  if (tickets.length === 0) {
    return (
      <section className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-3">
        <p className={cx('uppercase tracking-[0.16em]', militrinType.label)}>Meu acesso</p>
        <p className="mt-2 text-sm text-slate-300">{emptyTitle ?? 'Você ainda não possui ingressos.'}</p>
        {emptyDescription ? <p className="mt-1 text-xs text-slate-400">{emptyDescription}</p> : null}
        {emptyHref && emptyLabel ? (
          <MilitrinLinkButton href={emptyHref} variant="secondary" size="md" className="mt-3 w-full sm:w-auto">
            {emptyLabel}
          </MilitrinLinkButton>
        ) : null}
      </section>
    );
  }

  if (tickets.length > 1) {
    return (
      <section className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className={cx('uppercase tracking-[0.16em]', militrinType.label)}>Meus acessos</p>
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200">
            {tickets.length} ativos
          </span>
        </div>
        <p className="mt-2 text-sm text-slate-300">Você tem {tickets.length} ingressos ativos.</p>
        <MilitrinLinkButton href="/minha-conta/ingressos" variant="success" size="md" className="mt-3 w-full">
          Ver meus acessos
        </MilitrinLinkButton>
      </section>
    );
  }

  const current = tickets[0];
  const qrHref = `/minha-conta/ingressos/${current.ticketId}#qr`;
  const details = shirtLine(current);
  const whenWhere = metaLine(current);

  return (
    <section className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className={cx('uppercase tracking-[0.16em]', militrinType.label)}>Meu acesso</p>
        <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200">
          {current.status === 'used' ? 'Usado' : 'Ativo'}
        </span>
      </div>

      <div className="mt-2.5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className={cx('truncate text-sm font-semibold text-white')} title={current.eventName}>
            {current.eventName}
          </h3>
          {whenWhere ? <p className="mt-0.5 truncate text-xs text-slate-400">{whenWhere}</p> : null}
          <p className="mt-1.5 truncate text-xs text-slate-300">
            Titular: <span className="font-medium text-slate-100">{current.holderName || 'Não definido'}</span>
          </p>
          {details ? (
            <p className="truncate text-xs text-slate-300">
              Camiseta: <span className="font-medium text-slate-100">{details}</span>
            </p>
          ) : null}
        </div>

        {current.canShowTicket && current.token ? (
          <div className="hidden w-[96px] shrink-0 lg:flex">
            <div className="rounded-xl bg-white p-1.5">
              <LocalQrImage
                value={current.token}
                alt="QR Code do acesso Militrin"
                size={84}
                className="h-[84px] w-[84px] bg-white"
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {current.canShowTicket ? (
          <MilitrinLinkButton href={qrHref} variant="success" size="md" iconLeft={<QrCode size={16} />} className="w-full sm:flex-1">
            Abrir QR Code
          </MilitrinLinkButton>
        ) : null}
        <MilitrinLinkButton href={`/minha-conta/ingressos/${current.ticketId}`} variant="secondary" size="md" className="w-full sm:flex-1">
          Ver acesso
        </MilitrinLinkButton>
      </div>
    </section>
  );
}
