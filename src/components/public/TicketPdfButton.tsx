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
      doc.text(`Pedido: ${orderNumber || '-'}`, 48, 226);
      doc.text(`Token: ${token}`, 48, 248);

      doc.setFillColor(255, 255, 255);
      doc.roundedRect(48, 276, 300, 300, 12, 12, 'F');
      doc.addImage(qrDataUrl, 'PNG', 66, 294, 264, 264);
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
