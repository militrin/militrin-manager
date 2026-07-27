'use client';

import Image from 'next/image';
import { useMemo, useState } from 'react';

type TicketViewerProps = {
  eventName: string;
  participantName?: string;
  status: string;
  categoryName?: string | null;
  eventDate?: string | null;
  eventLocation?: string | null;
  token: string;
};

function makeQrUrl(token: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(token)}`;
}

export function TicketViewer({ eventName, participantName, status, categoryName, eventDate, eventLocation, token }: TicketViewerProps) {
  const [open, setOpen] = useState(false);
  const qrUrl = useMemo(() => makeQrUrl(token), [token]);

  const showTicket = async () => {
    setOpen(true);
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (type: 'screen') => Promise<unknown>;
      };
    };

    if (nav.wakeLock?.request) {
      try {
        await nav.wakeLock.request('screen');
      } catch {
        // ignore unsupported/denied wake lock
      }
    }
  };

  const downloadTicket = () => {
    const content = `Ingresso Militrin\nEvento: ${eventName}\nStatus: ${status}\nToken: ${token}\n`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `ingresso-${token}.txt`;
    a.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="space-y-3">
      <button type="button" onClick={showTicket} className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-emerald-950">
        Mostrar ingresso
      </button>
      <button type="button" onClick={downloadTicket} className="ml-2 rounded-xl border border-slate-600 px-3 py-2 text-xs text-slate-200">
        Baixar ingresso
      </button>

      {open ? (
        <div className="rounded-2xl border border-emerald-500/50 bg-slate-950 p-4 text-center">
          <p className="text-sm text-slate-300">{eventName}</p>
          {participantName ? <p className="text-sm text-slate-200">{participantName}</p> : null}
          {categoryName ? <p className="text-xs text-slate-400">Categoria: {categoryName}</p> : null}
          {eventDate ? <p className="text-xs text-slate-400">Data: {eventDate}</p> : null}
          {eventLocation ? <p className="text-xs text-slate-400">Local: {eventLocation}</p> : null}
          <p className="mb-3 mt-2 text-xs uppercase tracking-wide text-emerald-300">{status}</p>
          <Image src={qrUrl} alt="QR Code do ingresso" width={288} height={288} unoptimized className="mx-auto h-72 w-72 rounded-xl bg-white p-2" />
          <p className="mt-2 break-all text-xs text-slate-400">{token}</p>
        </div>
      ) : null}
    </div>
  );
}
