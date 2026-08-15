'use client';

import { useState } from 'react';
import { getStatusLabel } from '@/lib/status-labels';
import { applyReportPage, finalizeReportPages, formatReportDateTime, REPORT_THEME } from '@/lib/reports/report-theme';

type PaymentReceiptPdfButtonProps = {
  orderNumber: string;
  eventName: string;
  createdAt?: string | null;
  paymentStatus: string;
  paymentMethod?: string | null;
  finalAmount: string;
  itemsSummary?: string | null;
  className?: string;
};

export function PaymentReceiptPdfButton({
  orderNumber,
  eventName,
  createdAt,
  paymentStatus,
  paymentMethod,
  finalAmount,
  itemsSummary,
  className,
}: PaymentReceiptPdfButtonProps) {
  const [loading, setLoading] = useState(false);

  const downloadReceipt = async () => {
    setLoading(true);
    try {
      const [{ jsPDF }] = await Promise.all([import('jspdf')]);
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const generatedAt = new Date().toISOString();
      const { colors } = REPORT_THEME;

      applyReportPage(doc, 'Comprovante Militrin');
      doc.setFillColor(...colors.card);
      doc.setDrawColor(...colors.border);
      doc.roundedRect(42, 62, 511, 250, 7, 7, 'FD');
      doc.setTextColor(...colors.text);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(12);
      const detailLines = [
        `Pedido: ${orderNumber}`,
        `Evento: ${eventName}`,
        createdAt ? `Criado em: ${formatReportDateTime(createdAt)}` : null,
        `Pagamento: ${getStatusLabel(paymentStatus)}`,
        paymentMethod ? `Forma de pagamento: ${paymentMethod}` : null,
        `Valor pago: ${finalAmount}`,
      ].filter((line): line is string => Boolean(line));
      detailLines.forEach((line, index) => {
        if (index === 0) { doc.setFillColor(...colors.greenSoft); doc.roundedRect(54, 76, 475, 32, 4, 4, 'F'); doc.setTextColor(...colors.green); doc.setFont('helvetica', 'bold'); }
        else { doc.setTextColor(...colors.text); doc.setFont('helvetica', 'normal'); }
        doc.text(line, 64, 97 + (index * 28));
      });

      if (itemsSummary) {
        const lines = doc.splitTextToSize(`Ingressos: ${itemsSummary}`, 500);
        doc.setTextColor(...colors.muted);
        doc.text(lines, 64, 112 + (detailLines.length * 28));
      }

      finalizeReportPages(doc, generatedAt, 'Militrin · Comprovante');
      doc.save(`comprovante-${orderNumber}.pdf`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={downloadReceipt}
      disabled={loading}
      className={className ?? 'rounded-xl border border-slate-600 px-3 py-2 text-xs text-slate-200'}
    >
      {loading ? 'Gerando comprovante...' : 'Baixar comprovante'}
    </button>
  );
}
