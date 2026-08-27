import { CalendarDays, MapPin, ShoppingCart, Ticket as TicketIcon } from 'lucide-react';
import { cx } from './utils';
import { MilitrinLinkButton } from './MilitrinLinkButton';

export type MilitrinHeaderEvent = {
  name: string;
  date: string;
  schedule?: string | null;
  location: string;
};

type MilitrinHeaderProps = {
  event: MilitrinHeaderEvent;
  showBuyButton?: boolean;
  buyHref?: string;
  className?: string;
};

function HopWatermark({ className }: { className: string }) {
  return (
    <svg aria-hidden viewBox="0 0 64 88" className={className} fill="currentColor">
      <path d="M32 2C20 10 14 22 16 34c-6 2-10 8-10 15 0 9 8 16 18 16 3 0 6-1 9-2 3 1 6 2 9 2 10 0 18-7 18-16 0-7-4-13-10-15 2-12-4-24-16-32 1 5 0 10-2 14-2-4-3-9-2-14Zm-9 34c1 4 5 7 9 7s8-3 9-7c-3 2-6 3-9 3s-6-1-9-3Zm-3 12c1 3 4 5 7 5s6-2 7-5c-2 1-5 2-7 2s-5-1-7-2Zm18 0c1 3 4 5 7 5s6-2 7-5c-2 1-5 2-7 2s-5-1-7-2Z" />
    </svg>
  );
}

/**
 * Cabecalho global de marca (Militrin + evento em destaque), reutilizavel nas
 * paginas de Minha conta que precisam do mesmo contexto comercial (evento,
 * data, local, CTA de compra) -- fonte unica pra nao divergir estilo entre
 * Pedidos, Ingressos (listagem) e Detalhe do ingresso.
 *
 * Paleta: nada hardcoded -- reutiliza exatamente os tokens que o resto da
 * area logada ja usa (militrinTokens.surface/slate para o fundo/bordas,
 * var(--brand-*) pra marca, que e dinamica por organizacao via [data-brand]
 * em globals.css -- hoje verde neste projeto). Trocar o tema de marca da
 * plataforma atualiza este cabecalho automaticamente, sem editar este
 * arquivo.
 */
export function MilitrinHeader({ event, showBuyButton = true, buyHref = '/minha-conta/comprar', className }: MilitrinHeaderProps) {
  return (
    <header
      className={cx(
        'relative isolate overflow-hidden rounded-[2rem] border border-slate-800/80 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-5 shadow-lg shadow-black/30 sm:p-6',
        className,
      )}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_var(--brand-glow-strong),_transparent_45%),radial-gradient(circle_at_bottom_right,_var(--brand-glow-2),_transparent_50%)]" />
      <HopWatermark className="pointer-events-none absolute -right-4 -top-6 h-40 w-32 rotate-12 text-(--brand-400) opacity-[0.08]" />
      <HopWatermark className="pointer-events-none absolute -bottom-10 left-1/3 hidden h-32 w-24 -rotate-6 text-(--brand-400) opacity-[0.08] sm:block" />

      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col divide-y divide-dotted divide-slate-700/70 sm:flex-row sm:items-center sm:divide-x sm:divide-y-0">
          <div className="flex items-center gap-3 pb-4 sm:pb-0 sm:pr-5">
            <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl bg-black ring-1 ring-(--brand-500)/40 shadow-lg shadow-(--brand-600)/20">
              <div aria-hidden className="mask-logo absolute inset-0.5" />
            </div>
            <div className="min-w-0">
              <p className="text-lg font-bold leading-tight text-white">Militrin</p>
              <p className="text-xs font-semibold tracking-[0.3em] text-(--brand-300)">2026</p>
            </div>
          </div>

          <div className="flex items-start gap-2 py-4 sm:items-center sm:py-0 sm:px-5">
            <TicketIcon size={16} className="mt-0.5 shrink-0 text-(--brand-300) sm:mt-0" />
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Evento</p>
              <p className="truncate text-sm font-semibold text-white">{event.name}</p>
            </div>
          </div>

          <div className="flex items-start gap-2 py-4 sm:items-center sm:py-0 sm:px-5">
            <CalendarDays size={16} className="mt-0.5 shrink-0 text-(--brand-300) sm:mt-0" />
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Data do evento</p>
              <p className="truncate text-sm font-semibold text-white">{event.date}</p>
              {event.schedule ? <p className="truncate text-xs text-slate-400">{event.schedule}</p> : null}
            </div>
          </div>

          <div className="flex items-start gap-2 pt-4 sm:items-center sm:pt-0 sm:pl-5">
            <MapPin size={16} className="mt-0.5 shrink-0 text-(--brand-300) sm:mt-0" />
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Local</p>
              <p className="truncate text-sm font-semibold text-white">{event.location}</p>
            </div>
          </div>
        </div>

        {showBuyButton ? (
          <MilitrinLinkButton href={buyHref} variant="primary" size="md" iconLeft={<ShoppingCart size={16} />} className="shrink-0">
            Comprar ingresso
          </MilitrinLinkButton>
        ) : null}
      </div>
    </header>
  );
}
