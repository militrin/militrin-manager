import type { jsPDF } from 'jspdf';
import { STORE_PICKUP_PASS_COPY, type StorePickupPassData } from '../../lib/store/store-pickup-pass.ts';

// A4 retrato. Nunca usar formato customizado landscape (ex.: [720, 430])
// com orientation default do jsPDF: ele inverte para retrato e o QR
// desenhado à direita sai da página — causa raiz do QR ausente.
export const STORE_PICKUP_PDF_SIZE = { width: 595.28, height: 841.89 };
export const STORE_PICKUP_PNG_SIZE = { width: 1080, height: 1920 };
export const STORE_PICKUP_EXPORT_QR_SIZE = 640;
export const STORE_PICKUP_LOGO_PATH = '/militrin-logo.png';
export const STORE_PICKUP_PDF_QR_ALIAS = 'store-pickup-qr';
export const STORE_PICKUP_PDF_QR = { x: 40, size: 252, quiet: 16 };

const EMERALD: [number, number, number] = [16, 185, 129];
const EMERALD_SOFT: [number, number, number] = [167, 243, 208];
const SLATE: [number, number, number] = [15, 23, 42];
const MUTED: [number, number, number] = [100, 116, 139];
const WHITE: [number, number, number] = [255, 255, 255];
const PAPER: [number, number, number] = [248, 250, 252];
const CARD: [number, number, number] = [255, 255, 255];
const BORDER: [number, number, number] = [226, 232, 240];
const SUCCESS: [number, number, number] = [5, 150, 105];
const AMBER: [number, number, number] = [180, 83, 9];

export type StorePickupExportAssets = {
  qrDataUrl: string | null;
  logoDataUrl: string | null;
  productDataUrl: string | null;
};

function wrapPdfText(doc: jsPDF, text: string, maxWidth: number) {
  return doc.splitTextToSize(text, maxWidth) as string[];
}

function pdfImageFormat(dataUrl: string): 'PNG' | 'JPEG' | null {
  if (dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/jpg')) return 'JPEG';
  if (dataUrl.startsWith('data:image/png')) return 'PNG';
  return null;
}

function addContainedPdfImage(
  doc: jsPDF,
  dataUrl: string,
  format: 'PNG' | 'JPEG',
  box: { x: number; y: number; w: number; h: number },
) {
  const props = doc.getImageProperties(dataUrl);
  const scale = Math.min(box.w / props.width, box.h / props.height);
  const width = props.width * scale;
  const height = props.height * scale;
  doc.addImage(
    dataUrl,
    format,
    box.x + (box.w - width) / 2,
    box.y + (box.h - height) / 2,
    width,
    height,
    undefined,
    'MEDIUM',
  );
}

export function createStorePickupPdfDocument() {
  // format: 'a4' + portrait evita o swap silencioso de [width, height].
  return { unit: 'pt' as const, format: 'a4' as const, orientation: 'portrait' as const };
}

export function drawStorePickupPassPdf(
  doc: jsPDF,
  pass: StorePickupPassData,
  assets: StorePickupExportAssets,
) {
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  const pad = 40;
  const inner = w - pad * 2;
  const { x: qrX, size: qrSize, quiet } = STORE_PICKUP_PDF_QR;

  if (pass.canShowQr && !assets.qrDataUrl) {
    throw new Error('QR do comprovante não foi gerado.');
  }
  if (qrX + qrSize + quiet > w - pad) {
    throw new Error('QR do comprovante sairia da página.');
  }

  doc.setFillColor(...PAPER);
  doc.rect(0, 0, w, h, 'F');
  doc.setFillColor(...EMERALD);
  doc.rect(0, 0, w, 8, 'F');

  if (assets.logoDataUrl) {
    doc.setFillColor(...SLATE);
    doc.roundedRect(pad, 28, 48, 48, 10, 10, 'F');
    doc.addImage(assets.logoDataUrl, 'PNG', pad + 8, 36, 32, 32, undefined, 'FAST');
  }

  const titleX = assets.logoDataUrl ? pad + 60 : pad;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...SLATE);
  doc.text(STORE_PICKUP_PASS_COPY.brand, titleX, 48);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text('Comprovante de retirada', titleX, 66);

  doc.setFillColor(236, 253, 245);
  doc.roundedRect(w - pad - 132, 28, 132, 48, 12, 12, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...SUCCESS);
  doc.text(STORE_PICKUP_PASS_COPY.badgeTitle.toUpperCase(), w - pad - 66, 48, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.text(STORE_PICKUP_PASS_COPY.badgeSubtitle.toUpperCase(), w - pad - 66, 64, { align: 'center' });

  const imageBox = { x: pad, y: 96, w: inner, h: 180 };
  doc.setFillColor(...CARD);
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(1);
  doc.roundedRect(imageBox.x, imageBox.y, imageBox.w, imageBox.h, 16, 16, 'FD');
  const productFormat = assets.productDataUrl ? pdfImageFormat(assets.productDataUrl) : null;
  if (assets.productDataUrl && productFormat) {
    addContainedPdfImage(doc, assets.productDataUrl, productFormat, {
      x: imageBox.x + 16,
      y: imageBox.y + 12,
      w: imageBox.w - 32,
      h: imageBox.h - 24,
    });
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...MUTED);
    doc.text('LOJA / PRODUTO', w / 2, imageBox.y + imageBox.h / 2, { align: 'center' });
  }

  let y = imageBox.y + imageBox.h + 36;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...SLATE);
  const nameLines = wrapPdfText(doc, pass.productName, inner).slice(0, 2);
  nameLines.forEach((line) => {
    doc.text(line, pad, y);
    y += 26;
  });

  y += 10;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(STORE_PICKUP_PASS_COPY.variantLabel.toUpperCase(), pad, y);
  doc.text(STORE_PICKUP_PASS_COPY.quantityLabel.toUpperCase(), pad + inner / 2, y);
  y += 16;
  doc.setFontSize(13);
  doc.setTextColor(...SLATE);
  doc.text(pass.variantLabel || STORE_PICKUP_PASS_COPY.noVariant, pad, y);
  doc.text(pass.quantityLabel, pad + inner / 2, y);

  const qrY = y + 32;
  const footerReserve = 96;
  if (qrY + qrSize + quiet + footerReserve > h) {
    throw new Error('QR do comprovante sairia da página.');
  }

  const qrOuter = qrSize + quiet * 2;
  doc.setFillColor(...WHITE);
  doc.setDrawColor(...BORDER);
  doc.roundedRect(qrX - quiet, qrY - quiet, qrOuter, qrOuter, 14, 14, 'FD');
  if (pass.canShowQr && assets.qrDataUrl) {
    doc.addImage(
      assets.qrDataUrl,
      'PNG',
      qrX,
      qrY,
      qrSize,
      qrSize,
      STORE_PICKUP_PDF_QR_ALIAS,
      'NONE',
    );
  }

  const metaX = qrX + qrSize + quiet + 28;
  const metaWidth = w - pad - metaX;
  let metaY = qrY + 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(STORE_PICKUP_PASS_COPY.orderLabel.toUpperCase(), metaX, metaY);
  metaY += 20;
  doc.setFontSize(20);
  doc.setTextColor(...SLATE);
  doc.text(pass.orderNumber, metaX, metaY);
  metaY += 32;
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(STORE_PICKUP_PASS_COPY.orderDateLabel.toUpperCase(), metaX, metaY);
  metaY += 18;
  doc.setFontSize(13);
  doc.setTextColor(...SLATE);
  doc.text(pass.orderDateLabel, metaX, metaY);
  metaY += 32;
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text('STATUS', metaX, metaY);
  metaY += 18;
  const statusColor = pass.pickupStatus === 'delivered' ? SUCCESS : pass.pickupStatus === 'pending' ? AMBER : MUTED;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...statusColor);
  const statusText = pass.pickupStatusLabel.toUpperCase();
  if (pass.pickupStatus === 'delivered') {
    doc.setFillColor(...SUCCESS);
    doc.circle(metaX + 5, metaY - 4, 4.5, 'F');
    wrapPdfText(doc, statusText, metaWidth - 16).slice(0, 2).forEach((line) => {
      doc.text(line, metaX + 14, metaY);
      metaY += 16;
    });
  } else {
    wrapPdfText(doc, statusText, metaWidth).slice(0, 2).forEach((line) => {
      doc.text(line, metaX, metaY);
      metaY += 16;
    });
  }
  if (pass.pickupStatus === 'delivered' && pass.deliveredAtLabel) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...SLATE);
    doc.text(pass.deliveredAtLabel, metaX, metaY);
  }

  const footerY = qrY + qrSize + quiet + 28;
  doc.setFillColor(236, 253, 245);
  doc.roundedRect(pad, footerY, inner, 56, 12, 12, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(...SLATE);
  wrapPdfText(doc, pass.instruction, inner - 28).slice(0, 2).forEach((line, index) => {
    doc.text(line, pad + 14, footerY + 24 + index * 16);
  });

  return { qr: pass.canShowQr ? { x: qrX, y: qrY, size: qrSize } : null };
}

function cssRgb(color: [number, number, number]) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function wrapCanvasLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 3) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !current) {
      current = next;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

function drawContainedImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const sourceWidth = 'naturalWidth' in image && Number(image.naturalWidth) > 0
    ? Number(image.naturalWidth)
    : 'width' in image ? Number(image.width) : width;
  const sourceHeight = 'naturalHeight' in image && Number(image.naturalHeight) > 0
    ? Number(image.naturalHeight)
    : 'height' in image ? Number(image.height) : height;
  if (!sourceWidth || !sourceHeight) {
    ctx.drawImage(image, x, y, width, height);
    return;
  }
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

export function drawStorePickupPassPng(
  ctx: CanvasRenderingContext2D,
  pass: StorePickupPassData,
  assets: StorePickupExportAssets & {
    qrImage: CanvasImageSource | null;
    logoImage: CanvasImageSource | null;
    productImage: CanvasImageSource | null;
  },
) {
  const w = STORE_PICKUP_PNG_SIZE.width;
  const h = STORE_PICKUP_PNG_SIZE.height;
  const pad = 72;
  const inner = w - pad * 2;

  ctx.fillStyle = '#05080f';
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * 0.5, 220, 40, w * 0.5, 180, 700);
  glow.addColorStop(0, 'rgba(16, 185, 129, 0.28)');
  glow.addColorStop(1, 'rgba(5, 8, 15, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = cssRgb(EMERALD);
  ctx.fillRect(0, 0, w, 14);

  let y = 72;
  if (assets.logoImage) {
    ctx.fillStyle = '#000';
    roundRect(ctx, pad, y, 112, 112, 28);
    ctx.drawImage(assets.logoImage, pad + 16, y + 16, 80, 80);
  }
  ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
  roundRect(ctx, w - pad - 280, y + 8, 280, 96, 24);
  ctx.fillStyle = cssRgb(EMERALD_SOFT);
  ctx.font = '700 22px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(STORE_PICKUP_PASS_COPY.badgeTitle.toUpperCase(), w - pad - 28, y + 48);
  ctx.font = '600 20px sans-serif';
  ctx.fillText(STORE_PICKUP_PASS_COPY.badgeSubtitle.toUpperCase(), w - pad - 28, y + 80);
  ctx.textAlign = 'left';

  y += 160;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
  roundRect(ctx, pad, y, inner, 560, 40);
  if (assets.productImage) {
    drawContainedImage(ctx, assets.productImage, pad + 40, y + 40, inner - 80, 480);
  } else {
    ctx.fillStyle = cssRgb(EMERALD_SOFT);
    ctx.font = '700 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('LOJA', w / 2, y + 300);
    ctx.textAlign = 'left';
  }

  y += 612;
  ctx.fillStyle = '#fff';
  ctx.font = '700 56px sans-serif';
  wrapCanvasLines(ctx, pass.productName, inner, 2).forEach((line) => {
    ctx.fillText(line, pad, y);
    y += 64;
  });

  y += 12;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx.font = '700 20px sans-serif';
  ctx.fillText(STORE_PICKUP_PASS_COPY.variantLabel.toUpperCase(), pad, y);
  ctx.fillText(STORE_PICKUP_PASS_COPY.quantityLabel.toUpperCase(), pad + inner / 2, y);
  y += 42;
  ctx.fillStyle = cssRgb(EMERALD_SOFT);
  ctx.font = '700 34px sans-serif';
  ctx.fillText(pass.variantLabel || STORE_PICKUP_PASS_COPY.noVariant, pad, y);
  ctx.fillText(pass.quantityLabel, pad + inner / 2, y);

  y += 56;
  const qrBox = 520;
  ctx.fillStyle = '#fff';
  roundRect(ctx, pad, y, qrBox, qrBox, 36);
  if (assets.qrImage && pass.canShowQr) {
    ctx.drawImage(assets.qrImage, pad + 36, y + 36, qrBox - 72, qrBox - 72);
  }

  const metaX = pad + qrBox + 36;
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx.font = '700 20px sans-serif';
  ctx.fillText(STORE_PICKUP_PASS_COPY.orderLabel.toUpperCase(), metaX, y + 72);
  ctx.fillStyle = '#fff';
  ctx.font = '700 42px sans-serif';
  ctx.fillText(pass.orderNumber, metaX, y + 128);
  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx.font = '700 20px sans-serif';
  ctx.fillText(STORE_PICKUP_PASS_COPY.orderDateLabel.toUpperCase(), metaX, y + 196);
  ctx.fillStyle = '#fff';
  ctx.font = '700 32px sans-serif';
  ctx.fillText(pass.orderDateLabel, metaX, y + 244);

  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx.font = '700 20px sans-serif';
  ctx.fillText('STATUS', metaX, y + 292);
  const statusColor = pass.pickupStatus === 'delivered' ? cssRgb(SUCCESS) : pass.pickupStatus === 'pending' ? '#fbbf24' : '#94a3b8';
  ctx.fillStyle = statusColor;
  ctx.font = '700 28px sans-serif';
  const statusText = pass.pickupStatus === 'delivered'
    ? `✓ ${pass.pickupStatusLabel.toUpperCase()}`
    : pass.pickupStatusLabel.toUpperCase();
  wrapCanvasLines(ctx, statusText, inner - qrBox - 48, 2).forEach((line, index) => {
    ctx.fillText(line, metaX, y + 336 + index * 36);
  });
  if (pass.pickupStatus === 'delivered' && pass.deliveredAtLabel) {
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '600 24px sans-serif';
    ctx.fillText(pass.deliveredAtLabel, metaX, y + 424);
  }

  y += qrBox + 72;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
  roundRect(ctx, pad, y, inner, 160, 28);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '600 28px sans-serif';
  wrapCanvasLines(ctx, pass.instruction, inner - 64, 3).forEach((line, index) => {
    ctx.fillText(line, pad + 32, y + 56 + index * 36);
  });
}
