'use client';

import { QrCode } from 'lucide-react';
import { LocalQrImage } from '@/components/qr/LocalQrImage';
import { MilitrinLinkButton, cx, militrinType } from '@/components/militrin';
import type { AccountHomeTicketCard } from '@/lib/account/home-ticket-cards';

function shirtLine(ticket: AccountHomeTicketCard) {
  const shirt = ticket.shirtLabel ? ticket.shirtLabel.replace(/^camiseta\s+/i, '') : null;
  const parts = [shirt, ticket.batchLabel].filter(Boolean);
  return parts.length > 0 ? `Camiseta ${parts.join(' · ')}` : null;
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
      <section className="rounded-[1.5rem] border border-slate-800/80 bg-slate-900/70 p-4 shadow-lg shadow-black/10">
        <p className={cx('uppercase tracking-[0.18em] text-emerald-300', militrinType.label)}>Meu acesso</p>
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
      <section className="rounded-[1.5rem] border border-emerald-500/20 bg-gradient-to-br from-slate-900/90 to-slate-950 p-4 shadow-lg shadow-black/10">
        <div className="flex items-center justify-between gap-2">
          <p className={cx('uppercase tracking-[0.18em] text-emerald-300', militrinType.label)}>Meus acessos</p>
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200">
            {tickets.length} ativos
          </span>
        </div>
        <p className="mt-3 text-sm text-slate-300">Você tem {tickets.length} ingressos ativos.</p>
        <MilitrinLinkButton href="/minha-conta/ingressos" variant="success" size="md" className="mt-4 w-full">
          Ver meus acessos
        </MilitrinLinkButton>
      </section>
    );
  }

  const current = tickets[0];
  const qrHref = `/minha-conta/ingressos/${current.ticketId}#qr`;
  const details = shirtLine(current);
  const compactDate = current.compactDate || current.date;
  const desktopMeta = [current.date, current.location].filter(Boolean).join(' · ');

  return (
    <section className="rounded-[1.5rem] border border-emerald-500/20 bg-gradient-to-br from-slate-900/90 to-slate-950 p-4 shadow-lg shadow-black/10 transition hover:border-emerald-500/35">
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-base font-semibold text-white" title={current.eventName}>
          {current.eventName}
        </h3>
        <span className="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200">
          {current.status === 'used' ? 'Usado' : 'Ativo'}
        </span>
      </div>

      <div className="mt-3 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="hidden truncate text-sm text-slate-400 lg:block">{desktopMeta}</p>
          <p className="truncate text-sm text-slate-400 lg:hidden">{compactDate}</p>
          <p className="mt-2 truncate text-sm font-medium text-slate-100">{current.holderName || 'Não definido'}</p>
          {details ? <p className="truncate text-sm text-slate-300">{details}</p> : null}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            {current.canShowTicket ? (
              <MilitrinLinkButton href={qrHref} variant="success" size="md" iconLeft={<QrCode size={16} />} className="w-full min-w-0 sm:flex-1">
                Abrir QR Code
              </MilitrinLinkButton>
            ) : null}
            <MilitrinLinkButton href={`/minha-conta/ingressos/${current.ticketId}`} variant="secondary" size="md" className="w-full min-w-0 sm:flex-1">
              Ver acesso
            </MilitrinLinkButton>
          </div>
        </div>

        {current.canShowTicket && current.token ? (
          <div className="hidden w-[104px] shrink-0 lg:flex">
            <div className="rounded-xl bg-white p-1.5 shadow-lg shadow-black/30">
              <LocalQrImage
                value={current.token}
                alt="QR Code do acesso Militrin"
                size={92}
                className="h-[92px] w-[92px] bg-white"
              />
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
