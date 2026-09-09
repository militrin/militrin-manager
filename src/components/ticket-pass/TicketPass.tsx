import type { ReactNode } from 'react';
import { TicketEventInfo } from './TicketEventInfo';
import { TicketFooter } from './TicketFooter';
import { TicketHeader } from './TicketHeader';
import { TicketHolderInfo } from './TicketHolderInfo';
import { TicketQRCode } from './TicketQRCode';
import { buildTicketPassViewModel } from './ticket-pass-format';

export type TicketPassProps = {
  eventName: string;
  participantName?: string | null;
  status: string;
  categoryName?: string | null;
  eventDate?: string | null;
  eventLocation?: string | null;
  token: string;
  orderNumber?: string | null;
  qrDataUrl?: string | null;
  canShowQr?: boolean;
  qrUnavailableMessage?: string | null;
  titleAs?: 'h1' | 'h2';
  qrAnchorId?: string;
  actions?: ReactNode;
};

function HopWatermark({ className }: { className: string }) {
  return (
    <svg aria-hidden viewBox="0 0 64 88" className={className} fill="currentColor">
      <path d="M32 2C20 10 14 22 16 34c-6 2-10 8-10 15 0 9 8 16 18 16 3 0 6-1 9-2 3 1 6 2 9 2 10 0 18-7 18-16 0-7-4-13-10-15 2-12-4-24-16-32 1 5 0 10-2 14-2-4-3-9-2-14Zm-9 34c1 4 5 7 9 7s8-3 9-7c-3 2-6 3-9 3s-6-1-9-3Zm-3 12c1 3 4 5 7 5s6-2 7-5c-2 1-5 2-7 2s-5-1-7-2Zm18 0c1 3 4 5 7 5s6-2 7-5c-2 1-5 2-7 2s-5-1-7-2Z" />
    </svg>
  );
}

export function TicketPass({
  eventName,
  participantName,
  status,
  categoryName,
  eventDate,
  eventLocation,
  token,
  orderNumber,
  qrDataUrl = null,
  canShowQr = true,
  qrUnavailableMessage = null,
  titleAs = 'h2',
  qrAnchorId,
  actions,
}: TicketPassProps) {
  const model = buildTicketPassViewModel({
    eventName,
    participantName,
    status,
    categoryName,
    eventDate,
    eventLocation,
    token,
    orderNumber,
  });

  return (
    <div className="mx-auto w-full max-w-[400px]">
      <article className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#0a0a0c] text-zinc-100 shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--brand-glow-strong),transparent_55%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.045] mix-blend-overlay"
          style={{
            backgroundImage:
              'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.35) 2px, rgba(255,255,255,0.35) 3px), repeating-linear-gradient(90deg, transparent, transparent 3px, rgba(255,255,255,0.18) 3px, rgba(255,255,255,0.18) 4px)',
          }}
        />
        <HopWatermark className="pointer-events-none absolute -right-6 top-16 h-36 w-28 rotate-12 text-(--brand-400) opacity-[0.07]" />
        <div aria-hidden className="pointer-events-none absolute left-0 top-24 h-28 w-px bg-linear-to-b from-transparent via-(--brand-500)/40 to-transparent" />
        <div aria-hidden className="pointer-events-none absolute right-0 top-24 h-28 w-px bg-linear-to-b from-transparent via-(--brand-500)/40 to-transparent" />

        <div className="relative">
          <TicketHeader eventName={model.eventName} categoryName={model.categoryName} orderNumber={model.orderNumber} titleAs={titleAs} />
          <TicketEventInfo dateParts={model.dateParts} location={model.location} />
          <TicketHolderInfo
            holderName={model.holderName}
            categoryName={model.categoryName}
            orderNumber={model.orderNumber}
            status={model.status}
          />

          <div className="relative mt-6">
            <span aria-hidden className="absolute -left-3 top-1/2 z-10 h-6 w-6 -translate-y-1/2 rounded-full bg-[var(--ticket-notch,var(--background))]" />
            <span aria-hidden className="absolute -right-3 top-1/2 z-10 h-6 w-6 -translate-y-1/2 rounded-full bg-[var(--ticket-notch,var(--background))]" />
            <div aria-hidden className="mx-6 border-t border-dashed border-white/12" />
          </div>

          <TicketQRCode
            token={model.token}
            qrDataUrl={qrDataUrl}
            canShow={canShowQr}
            unavailableMessage={qrUnavailableMessage}
            anchorId={qrAnchorId}
          />
          <TicketFooter />
        </div>
      </article>

      {actions ? <div className="mt-4 w-full">{actions}</div> : null}
    </div>
  );
}
