'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { generateQrDataUrl } from '@/lib/qr/generate-qr-data-url';
import { STORE_PICKUP_PASS_COPY, storePickupPassFileStem, type StorePickupPassData } from '@/lib/store/store-pickup-pass';
import {
  createStorePickupPdfDocument,
  drawStorePickupPassPdf,
  drawStorePickupPassPng,
  STORE_PICKUP_EXPORT_QR_SIZE,
  STORE_PICKUP_LOGO_PATH,
  STORE_PICKUP_PNG_SIZE,
} from '@/components/store/store-pickup-pass-export';
import { cx, militrinButtonSize, militrinButtonVariant, militrinTokens } from '@/components/militrin';

type ExportKind = 'pdf' | 'png';

async function fetchAsDataUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Falha ao carregar arquivo.');
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Falha ao ler arquivo.'));
    reader.readAsDataURL(blob);
  });
}

function loadHtmlImage(src: string, crossOrigin = false) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    if (crossOrigin) image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Falha ao carregar imagem.'));
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

export function StorePickupPassActions({
  pass,
  className,
}: {
  pass: StorePickupPassData;
  className?: string;
}) {
  const [loading, setLoading] = useState<ExportKind | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const exportPass = async (kind: ExportKind) => {
    setErrorMessage(null);
    setLoading(kind);
    try {
      const [qrDataUrl, logoDataUrl, productDataUrl] = await Promise.all([
        pass.canShowQr && pass.qrPayload
          ? generateQrDataUrl(pass.qrPayload, STORE_PICKUP_EXPORT_QR_SIZE)
          : Promise.resolve(null),
        fetchAsDataUrl(STORE_PICKUP_LOGO_PATH).catch(() => null),
        pass.productImageUrl ? fetchAsDataUrl(pass.productImageUrl).catch(() => null) : Promise.resolve(null),
      ]);
      const stem = storePickupPassFileStem(pass);
      const assets = { qrDataUrl, logoDataUrl, productDataUrl };

      if (kind === 'pdf') {
        const { jsPDF } = await import('jspdf');
        const doc = new jsPDF(createStorePickupPdfDocument());
        drawStorePickupPassPdf(doc, pass, assets);
        doc.save(`${stem}.pdf`);
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = STORE_PICKUP_PNG_SIZE.width;
      canvas.height = STORE_PICKUP_PNG_SIZE.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Não foi possível gerar a imagem.');
      const [qrImage, logoImage, productImage] = await Promise.all([
        qrDataUrl ? loadHtmlImage(qrDataUrl).catch(() => null) : Promise.resolve(null),
        logoDataUrl ? loadHtmlImage(logoDataUrl).catch(() => null) : Promise.resolve(null),
        productDataUrl ? loadHtmlImage(productDataUrl, true).catch(() => null) : Promise.resolve(null),
      ]);
      drawStorePickupPassPng(context, pass, { ...assets, qrImage, logoImage, productImage });
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error('Não foi possível gerar a imagem.'));
        }, 'image/png');
      });
      triggerDownload(blob, `${stem}.png`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Falha ao gerar o arquivo.');
    } finally {
      setLoading(null);
    }
  };

  const buttonClass = cx(
    'inline-flex w-full items-center justify-center gap-2 rounded-2xl font-semibold transition disabled:opacity-60 sm:w-auto',
    militrinButtonSize.md,
    militrinTokens.focusRing,
  );

  return (
    <div className={cx('flex w-full flex-col gap-2', className)}>
      <div className="flex w-full flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => void exportPass('png')}
          disabled={Boolean(loading)}
          className={cx(buttonClass, militrinButtonVariant.secondary)}
        >
          <Download size={16} />
          {loading === 'png' ? STORE_PICKUP_PASS_COPY.generatingImage : STORE_PICKUP_PASS_COPY.downloadImage}
        </button>
        <button
          type="button"
          onClick={() => void exportPass('pdf')}
          disabled={Boolean(loading)}
          className={cx(buttonClass, militrinButtonVariant.secondary)}
        >
          <Download size={16} />
          {loading === 'pdf' ? STORE_PICKUP_PASS_COPY.generatingPdf : STORE_PICKUP_PASS_COPY.downloadPdf}
        </button>
      </div>
      {errorMessage ? <p className="text-xs text-rose-300">{errorMessage}</p> : null}
    </div>
  );
}
