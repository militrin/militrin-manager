'use client';

import { useState } from 'react';
import { getStatusLabel } from '@/lib/status-labels';
import { applyReportPage, finalizeReportPages, formatReportDateTime, REPORT_THEME, splitTechnicalIdentifier } from '@/lib/reports/report-theme';

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
      const generatedAt = new Date().toISOString();
      const { colors } = REPORT_THEME;

      applyReportPage(doc, 'Ingresso Militrin');

      // Header block.
      doc.setFillColor(...colors.card);
      doc.roundedRect(40, 56, 515, 58, 8, 8, 'F');
      doc.setDrawColor(...colors.border);
      doc.roundedRect(40, 56, 515, 58, 8, 8, 'S');

      doc.setTextColor(...colors.text);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.text(eventName, 56, 89);

      if (logoDataUrl) {
        doc.addImage(logoDataUrl, 'PNG', 446, 61, 96, 46);
      } else {
        doc.setFillColor(...colors.green);
        doc.roundedRect(456, 68, 86, 30, 7, 7, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.text('MILITRIN', 499, 88, { align: 'center' });
        doc.setTextColor(...colors.text);
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(12);
      const detailLines = [
        `Evento: ${eventName}`,
        participantName ? `Titular: ${participantName}` : null,
        categoryName ? `Categoria: ${categoryName}` : null,
        `Ingresso: ${getStatusLabel(status)}`,
        eventDate ? `Data: ${formatReportDateTime(eventDate)}` : null,
        eventLocation ? `Local: ${eventLocation}` : null,
        orderNumber ? `Pedido: ${orderNumber}` : null,
      ].filter((line): line is string => Boolean(line));
      detailLines.forEach((line, index) => doc.text(line, 56, 145 + (index * 21)));

      doc.setTextColor(...colors.muted);
      doc.setFontSize(10);
      doc.setFont('courier', 'normal');
      doc.text('Identificação técnica:', 56, 166 + (detailLines.length * 21));
      doc.text(splitTechnicalIdentifier(token, 54), 56, 180 + (detailLines.length * 21));

      doc.setFillColor(...colors.white);
      doc.setDrawColor(...colors.border);
      doc.roundedRect(56, 330, 300, 300, 12, 12, 'FD');
      doc.addImage(qrDataUrl, 'PNG', 74, 348, 264, 264);

      doc.setFontSize(10);
      doc.setTextColor(...colors.muted);
      doc.text('Apresente este QR Code na entrada do evento.', 56, 650);
      finalizeReportPages(doc, generatedAt, 'Militrin · Ingresso');
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
