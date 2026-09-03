'use client';

import { useState } from 'react';
import { generateQrDataUrl } from '@/lib/qr/generate-qr-data-url';
import { applyReportPage, finalizeReportPages, REPORT_THEME } from '@/lib/reports/report-theme';

type StoreOrderReceiptItem = {
  quantity: number;
  name: string;
  variantText?: string | null;
};

type StoreOrderReceiptButtonsProps = {
  storeOrderId: string;
  orderNumber: string;
  eventName?: string | null;
  items: StoreOrderReceiptItem[];
  className?: string;
};

async function fetchAsDataUrl(url: string, errorMessage: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(errorMessage);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(errorMessage));
    reader.readAsDataURL(blob);
  });
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function svgUrlToPngBlob(svgUrl: string): Promise<Blob> {
  const response = await fetch(svgUrl);
  if (!response.ok) throw new Error('Falha ao gerar comprovante.');
  const svgText = await response.text();
  const objectUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Falha ao carregar comprovante.'));
      img.src = objectUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Este navegador não suporta gerar a imagem.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Falha ao gerar a imagem.'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function StoreOrderReceiptButtons({ storeOrderId, orderNumber, eventName, items, className }: StoreOrderReceiptButtonsProps) {
  const [loadingImage, setLoadingImage] = useState(false);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const downloadImage = async () => {
    setErrorMessage(null);
    setLoadingImage(true);
    try {
      const blob = await svgUrlToPngBlob(`/api/loja/pedidos/${storeOrderId}/qrcode`);
      triggerBlobDownload(blob, `pedido-${orderNumber}.png`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Falha ao baixar a imagem.');
    } finally {
      setLoadingImage(false);
    }
  };

  const downloadPdf = async () => {
    setErrorMessage(null);
    setLoadingPdf(true);
    try {
      const [{ jsPDF }, qrDataUrl] = await Promise.all([
        import('jspdf'),
        generateQrDataUrl(orderNumber, 320),
      ]);

      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const generatedAt = new Date().toISOString();
      const { colors } = REPORT_THEME;
      const rgb = (value: readonly [number, number, number]) => [value[0], value[1], value[2]] as [number, number, number];

      applyReportPage(doc, 'Comprovante de retirada — Loja');

      doc.setFillColor(...rgb(colors.card));
      doc.roundedRect(40, 56, 515, 58, 8, 8, 'F');
      doc.setDrawColor(...rgb(colors.border));
      doc.roundedRect(40, 56, 515, 58, 8, 8, 'S');
      doc.setTextColor(...rgb(colors.text));
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(16);
      doc.text(eventName || 'Evento', 56, 89);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(12);
      doc.text(`Pedido: ${orderNumber}`, 56, 145);
      doc.text('Status: Pagamento confirmado', 56, 166);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.text('Itens a retirar', 56, 200);
      doc.setFont('helvetica', 'normal');
      items.forEach((item, index) => {
        const line = `${item.quantity}x ${item.name}${item.variantText ? ` — ${item.variantText}` : ''}`;
        doc.text(line, 56, 222 + index * 20);
      });

      doc.setFillColor(...rgb(colors.white));
      doc.setDrawColor(...rgb(colors.border));
      doc.roundedRect(56, 330, 300, 300, 12, 12, 'FD');
      doc.addImage(qrDataUrl, 'PNG', 74, 348, 264, 264);

      doc.setFontSize(10);
      doc.setTextColor(...rgb(colors.muted));
      doc.text('Apresente este comprovante na retirada dos itens no evento.', 56, 650);
      finalizeReportPages(doc, generatedAt, 'Militrin · Loja');
      doc.save(`pedido-${orderNumber}.pdf`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Falha ao gerar o PDF.');
    } finally {
      setLoadingPdf(false);
    }
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={downloadImage}
          disabled={loadingImage}
          className="inline-flex h-9 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200 disabled:opacity-50"
        >
          {loadingImage ? 'Gerando imagem...' : 'Baixar imagem'}
        </button>
        <button
          type="button"
          onClick={downloadPdf}
          disabled={loadingPdf}
          className="inline-flex h-9 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200 disabled:opacity-50"
        >
          {loadingPdf ? 'Gerando PDF...' : 'Baixar PDF'}
        </button>
      </div>
      {errorMessage ? <p className="mt-2 text-xs text-rose-300">{errorMessage}</p> : null}
    </div>
  );
}
