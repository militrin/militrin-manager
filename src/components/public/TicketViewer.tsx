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

  const downloadTicket = async () => {
    const [{ jsPDF }] = await Promise.all([
      import('jspdf'),
    ]);

    const response = await fetch(qrUrl);
    const qrBlob = await response.blob();
    const qrDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('Falha ao gerar QR do ingresso.'));
      reader.readAsDataURL(qrBlob);
    });

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    doc.setFillColor(9, 16, 33);
    doc.rect(0, 0, 595, 842, 'F');
    doc.setTextColor(226, 232, 240);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.text('Ingresso Militrin', 48, 60);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    doc.text(`Evento: ${eventName}`, 48, 94);
    doc.text(`Participante: ${participantName || '-'}`, 48, 116);
    doc.text(`Categoria: ${categoryName || '-'}`, 48, 138);
    doc.text(`Status: ${status}`, 48, 160);
    doc.text(`Data: ${eventDate || '-'}`, 48, 182);
    doc.text(`Local: ${eventLocation || '-'}`, 48, 204);
    doc.text(`Token: ${token}`, 48, 226);

    doc.setFillColor(255, 255, 255);
    doc.roundedRect(48, 260, 300, 300, 12, 12, 'F');
    doc.addImage(qrDataUrl, 'PNG', 66, 278, 264, 264);

    doc.save(`ingresso-${token}.pdf`);
  };

  return (
    <div className="space-y-3">
      <button type="button" onClick={showTicket} className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-emerald-950">
        Mostrar ingresso
      </button>
      <button type="button" onClick={downloadTicket} className="ml-2 rounded-xl border border-slate-600 px-3 py-2 text-xs text-slate-200">
        Baixar ingresso PDF
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
