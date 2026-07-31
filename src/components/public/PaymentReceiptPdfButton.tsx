'use client';

import { useState } from 'react';

type PaymentReceiptPdfButtonProps = {
  orderNumber: string;
  eventName: string;
  createdAt?: string | null;
  paymentStatus: string;
  paymentMethod: string;
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

      doc.setFillColor(9, 16, 33);
      doc.rect(0, 0, 595, 842, 'F');
      doc.setTextColor(226, 232, 240);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.text('Comprovante Militrin', 48, 60);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(12);
      doc.text(`Pedido: ${orderNumber}`, 48, 96);
      doc.text(`Evento: ${eventName}`, 48, 118);
      doc.text(`Criado em: ${createdAt ?? '-'}`, 48, 140);
      doc.text(`Status do pagamento: ${paymentStatus}`, 48, 162);
      doc.text(`Forma de pagamento: ${paymentMethod}`, 48, 184);
      doc.text(`Valor pago: ${finalAmount}`, 48, 206);

      if (itemsSummary) {
        const lines = doc.splitTextToSize(`Ingressos: ${itemsSummary}`, 500);
        doc.text(lines, 48, 238);
      }

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
