'use client';

import { useState } from 'react';

type TicketPdfButtonProps = {
  eventName: string;
  participantName?: string;
  status: string;
  categoryName?: string | null;
  eventDate?: string | null;
  eventLocation?: string | null;
  token: string;
  orderNumber?: string | null;
  className?: string;
};

function makeQrUrl(token: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(token)}`;
}

const TICKET_PDF_LOGO_PATH = '/militrin-logo.png';

async function fetchAsDataUrl(url: string, errorMessage: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(errorMessage);
  }
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(errorMessage));
    reader.readAsDataURL(blob);
  });
}

export function TicketPdfButton({
  eventName,
  participantName,
  status,
  categoryName,
  eventDate,
  eventLocation,
  token,
  orderNumber,
  className,
}: TicketPdfButtonProps) {
  const [loading, setLoading] = useState(false);

  const downloadTicket = async () => {
    setLoading(true);
    try {
      const [{ jsPDF }] = await Promise.all([import('jspdf')]);

      const qrUrl = makeQrUrl(token);
      const qrDataUrl = await fetchAsDataUrl(qrUrl, 'Falha ao gerar QR do ingresso.');

      let logoDataUrl: string | null = null;
      try {
        logoDataUrl = await fetchAsDataUrl(TICKET_PDF_LOGO_PATH, 'Falha ao carregar logo.');
      } catch {
        // Fallback badge is rendered below when the logo file is unavailable.
      }

      const doc = new jsPDF({ unit: 'pt', format: 'a4' });

      // White card-like background.
      doc.setFillColor(255, 255, 255);
      doc.rect(0, 0, 595, 842, 'F');

      // Header block.
      doc.setFillColor(245, 247, 250);
      doc.roundedRect(40, 32, 515, 72, 10, 10, 'F');
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(40, 32, 515, 72, 10, 10, 'S');

      doc.setTextColor(15, 23, 42);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.text('Ingresso Militrin', 56, 74);

      if (logoDataUrl) {
        doc.addImage(logoDataUrl, 'PNG', 446, 42, 96, 52);
      } else {
        doc.setFillColor(236, 72, 153);
        doc.roundedRect(456, 50, 86, 34, 8, 8, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text('MILITRIN', 499, 71, { align: 'center' });
        doc.setTextColor(15, 23, 42);
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(12);
      doc.text(`Evento: ${eventName}`, 56, 142);
      doc.text(`Participante: ${participantName || '-'}`, 56, 164);
      doc.text(`Categoria: ${categoryName || '-'}`, 56, 186);
      doc.text(`Status: ${status}`, 56, 208);
      doc.text(`Data: ${eventDate || '-'}`, 56, 230);
      doc.text(`Local: ${eventLocation || '-'}`, 56, 252);
      doc.text(`Pedido: ${orderNumber || '-'}`, 56, 274);

      doc.setTextColor(71, 85, 105);
      doc.setFontSize(10);
      doc.text(`Token: ${token}`, 56, 302);

      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(203, 213, 225);
      doc.roundedRect(56, 330, 300, 300, 12, 12, 'FD');
      doc.addImage(qrDataUrl, 'PNG', 74, 348, 264, 264);

      doc.setFontSize(10);
      doc.setTextColor(100, 116, 139);
      doc.text('Apresente este QR Code na entrada do evento.', 56, 650);
      doc.save(`ingresso-${token}.pdf`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={downloadTicket}
      disabled={loading}
      className={className ?? 'rounded-xl border border-slate-600 px-3 py-2 text-xs text-slate-200'}
    >
      {loading ? 'Gerando PDF...' : 'Baixar PDF'}
    </button>
  );
}
