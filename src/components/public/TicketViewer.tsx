import Image from 'next/image';
import { TicketPdfButton } from './TicketPdfButton';
import { getStatusLabel } from '@/lib/status-labels';

type TicketViewerProps = {
  eventName: string;
  participantName?: string;
  status: string;
  categoryName?: string | null;
  eventDate?: string | null;
  eventLocation?: string | null;
  token: string;
  orderNumber?: string | null;
  showPdfButton?: boolean;
};

function makeQrUrl(token: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(token)}`;
}

export function TicketViewer({
  eventName,
  participantName,
  status,
  categoryName,
  eventDate,
  eventLocation,
  token,
  orderNumber,
  showPdfButton = true,
}: TicketViewerProps) {
  const qr = makeQrUrl(token);

  return (
    <article className="overflow-hidden rounded-[1.75rem] border border-slate-700 bg-slate-950/70">
      <div className="grid gap-0 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Ingresso digital</p>
          <h3 className="mt-2 text-xl font-semibold text-white">{eventName}</h3>
          {participantName ? <p className="mt-1 text-sm text-slate-300">Titular: {participantName}</p> : null}

          <div className="mt-4 grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
            {categoryName ? <p>Categoria: {categoryName}</p> : null}
            <p>Ingresso: {getStatusLabel(status)}</p>
            {eventDate ? <p>Data: {eventDate}</p> : null}
            {eventLocation ? <p>Local: {eventLocation}</p> : null}
            {orderNumber ? <p>Pedido: {orderNumber}</p> : null}
          </div>

          {showPdfButton ? (
            <div className="mt-4">
              <TicketPdfButton
                eventName={eventName}
                participantName={participantName}
                status={status}
                categoryName={categoryName}
                eventDate={eventDate}
                eventLocation={eventLocation}
                token={token}
                orderNumber={orderNumber}
                className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-600 px-4 text-xs font-semibold text-slate-100 transition hover:bg-slate-800"
              />
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-center border-t border-slate-700 bg-slate-900/70 p-5 lg:border-l lg:border-t-0">
          <div className="rounded-2xl border border-slate-700 bg-white p-3">
            <Image src={qr} alt="QR Code do ingresso" width={220} height={220} className="h-[220px] w-[220px]" unoptimized />
          </div>
        </div>
      </div>
    </article>
  );
}
