'use client';

import { useState } from 'react';
import { generateQrDataUrl } from '@/lib/qr/generate-qr-data-url';
import { cx, militrinButtonSize, militrinButtonVariant, militrinTokens } from '@/components/militrin';
import { readTicketPassAccent } from '@/components/ticket-pass/ticket-pass-accent';
import {
  drawTicketPassPdf,
  drawTicketPassPng,
  TICKET_PASS_EXPORT_QR_SIZE,
  TICKET_PASS_LOGO_PATH,
  TICKET_PASS_PDF_SIZE,
  TICKET_PASS_PNG_SIZE,
} from '@/components/ticket-pass/ticket-pass-export';
import {
  buildTicketPassViewModel,
  TICKET_PASS_COPY,
  ticketPassExportFileStem,
} from '@/components/ticket-pass/ticket-pass-format';

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

type ExportKind = 'pdf' | 'png';

async function fetchAsDataUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Falha ao carregar logo.');
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Falha ao carregar logo.'));
    reader.readAsDataURL(blob);
  });
}

function loadHtmlImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Falha ao carregar imagem do ingresso.'));
    image.src = src;
  });
}

function triggerDownload(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
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
  const [loading, setLoading] = useState<ExportKind | null>(null);

  const exportTicket = async (kind: ExportKind) => {
    setLoading(kind);
    try {
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
      const accent = readTicketPassAccent();
      const [qrDataUrl, logoDataUrl] = await Promise.all([
        generateQrDataUrl(model.token, TICKET_PASS_EXPORT_QR_SIZE),
        fetchAsDataUrl(TICKET_PASS_LOGO_PATH).catch(() => null),
      ]);
      const stem = ticketPassExportFileStem(model);
      const assets = {
        qrDataUrl,
        logoDataUrl,
        accent: accent.accent,
        accentSoft: accent.accentSoft,
      };

      if (kind === 'pdf') {
        const { jsPDF } = await import('jspdf');
        const doc = new jsPDF({
          unit: 'pt',
          format: [TICKET_PASS_PDF_SIZE.width, TICKET_PASS_PDF_SIZE.height],
          orientation: 'portrait',
        });
        drawTicketPassPdf(doc, model, assets);
        doc.save(`${stem}.pdf`);
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = TICKET_PASS_PNG_SIZE.width;
      canvas.height = TICKET_PASS_PNG_SIZE.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Não foi possível gerar a imagem do ingresso.');
      const [qrImage, logoImage] = await Promise.all([
        loadHtmlImage(qrDataUrl),
        logoDataUrl ? loadHtmlImage(logoDataUrl).catch(() => null) : Promise.resolve(null),
      ]);
      drawTicketPassPng(context, model, { ...assets, qrImage, logoImage });
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error('Não foi possível gerar a imagem do ingresso.'));
        }, 'image/png');
      });
      triggerDownload(blob, `${stem}.png`);
    } finally {
      setLoading(null);
    }
  };

  const buttonClass = cx(
    'inline-flex w-full items-center justify-center rounded-2xl font-semibold transition disabled:opacity-60 sm:w-auto',
    militrinButtonSize.md,
    militrinTokens.focusRing,
  );

  return (
    <div className={cx('flex w-full flex-col gap-2 sm:flex-row sm:justify-center', className)}>
      <button
        type="button"
        onClick={() => void exportTicket('pdf')}
        disabled={Boolean(loading)}
        className={cx(buttonClass, militrinButtonVariant.primary)}
      >
        {loading === 'pdf' ? TICKET_PASS_COPY.generatingPdf : TICKET_PASS_COPY.downloadPdf}
      </button>
      <button
        type="button"
        onClick={() => void exportTicket('png')}
        disabled={Boolean(loading)}
        className={cx(buttonClass, militrinButtonVariant.secondary)}
      >
        {loading === 'png' ? TICKET_PASS_COPY.generatingImage : TICKET_PASS_COPY.downloadImage}
      </button>
    </div>
  );
}
