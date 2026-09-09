import type { jsPDF } from 'jspdf';
import { TICKET_PASS_NEUTRAL, type TicketPassRgb } from './ticket-pass-accent.ts';
import { TICKET_PASS_COPY, type TicketPassViewModel } from './ticket-pass-format.ts';

export const TICKET_PASS_PDF_SIZE = { width: 396, height: 820 };
export const TICKET_PASS_PNG_SIZE = { width: 1080, height: 1920 };
export const TICKET_PASS_EXPORT_QR_SIZE = 640;
export const TICKET_PASS_LOGO_PATH = '/militrin-logo.png';

export type TicketPassExportAssets = {
  qrDataUrl: string;
  logoDataUrl: string | null;
  accent: TicketPassRgb;
  accentSoft: TicketPassRgb;
};

function rgb(color: TicketPassRgb): [number, number, number] {
  return [color[0], color[1], color[2]];
}

function wrapPdfText(doc: jsPDF, text: string, maxWidth: number) {
  return doc.splitTextToSize(text, maxWidth) as string[];
}

export function drawTicketPassPdf(doc: jsPDF, model: TicketPassViewModel, assets: TicketPassExportAssets) {
  const { width: w, height: h } = TICKET_PASS_PDF_SIZE;
  const pad = 28;
  const inner = w - pad * 2;
  const { background, card, text, muted, subtle, white, success } = TICKET_PASS_NEUTRAL;

  doc.setFillColor(...rgb(background));
  doc.rect(0, 0, w, h, 'F');
  doc.setFillColor(...rgb(assets.accent));
  doc.rect(0, 0, w, 5, 'F');

  let y = 28;

  if (assets.logoDataUrl) {
    doc.setFillColor(0, 0, 0);
    doc.roundedRect(pad, y, 52, 52, 10, 10, 'F');
    doc.addImage(assets.logoDataUrl, 'PNG', pad + 6, y + 6, 40, 40, undefined, 'FAST');
  }

  if (model.orderNumber) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...rgb(subtle));
    doc.text(model.orderNumber, w - pad, y + 18, { align: 'right' });
  }

  y += 68;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...rgb(assets.accentSoft));
  doc.text(TICKET_PASS_COPY.eyebrow.toUpperCase(), pad, y);

  y += 22;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...rgb(text));
  const eventLines = wrapPdfText(doc, model.eventName, inner);
  eventLines.slice(0, 3).forEach((line) => {
    doc.text(line, pad, y);
    y += 24;
  });

  if (model.categoryName) {
    y += 2;
    doc.setFontSize(13);
    doc.setTextColor(...rgb(text));
    wrapPdfText(doc, model.categoryName.toUpperCase(), inner).slice(0, 2).forEach((line) => {
      doc.text(line, pad, y);
      y += 16;
    });
  }

  if (model.dateParts) {
    y += 18;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(36);
    doc.setTextColor(...rgb(text));
    doc.text(model.dateParts.day, pad, y + 8);
    const dayWidth = doc.getTextWidth(model.dateParts.day);
    doc.setFontSize(11);
    doc.setTextColor(...rgb(assets.accentSoft));
    doc.text(model.dateParts.month, pad + dayWidth + 10, y - 8);
    doc.setTextColor(...rgb(muted));
    doc.text(model.dateParts.year, pad + dayWidth + 10, y + 8);
    if (model.dateParts.time) {
      doc.setFontSize(14);
      doc.setTextColor(...rgb(text));
      doc.text(model.dateParts.time, pad + dayWidth + 72, y + 2);
    }
    y += 28;
  }

  if (model.location) {
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...rgb(text));
    wrapPdfText(doc, model.location, inner).slice(0, 2).forEach((line) => {
      doc.text(line, pad, y);
      y += 14;
    });
  }

  const rows: Array<{ label: string; value: string; valueColor: TicketPassRgb }> = [];
  if (model.holderName) rows.push({ label: TICKET_PASS_COPY.holderLabel, value: model.holderName, valueColor: text });
  if (model.categoryName) rows.push({ label: TICKET_PASS_COPY.categoryLabel, value: model.categoryName, valueColor: text });
  if (model.orderNumber) rows.push({ label: TICKET_PASS_COPY.orderLabel, value: model.orderNumber, valueColor: text });
  rows.push({
    label: TICKET_PASS_COPY.statusLabel,
    value: model.statusIsActive ? `ATIVO` : model.statusText,
    valueColor: model.statusIsActive ? success : text,
  });

  y += 16;
  const rowHeight = 36;
  rows.forEach((row) => {
    doc.setFillColor(...rgb(card));
    doc.roundedRect(pad, y, inner, rowHeight, 8, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(...rgb(subtle));
    doc.text(row.label.toUpperCase(), pad + 12, y + 13);
    doc.setFontSize(11);
    doc.setTextColor(...rgb(row.valueColor));
    const valueLines = wrapPdfText(doc, row.value, inner - 24);
    doc.text(valueLines[0] ?? '', pad + 12, y + 27);
    y += rowHeight + 6;
  });

  const qrBox = 190;
  const remaining = h - y - 150;
  const qrOuter = Math.max(150, Math.min(qrBox, remaining - 8));
  const qrX = (w - qrOuter) / 2;
  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...rgb(assets.accentSoft));
  doc.text(TICKET_PASS_COPY.qrPurpose.toUpperCase(), w / 2, y, { align: 'center' });
  y += 10;
  doc.setFillColor(...rgb(assets.accent));
  doc.roundedRect(qrX, y, qrOuter, qrOuter, 14, 14, 'F');
  doc.setFillColor(...rgb(white));
  doc.roundedRect(qrX + 5, y + 5, qrOuter - 10, qrOuter - 10, 11, 11, 'F');
  const qrInner = qrOuter - 28;
  doc.addImage(assets.qrDataUrl, 'PNG', qrX + 14, y + 14, qrInner, qrInner, undefined, 'FAST');
  y += qrOuter + 18;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...rgb(muted));
  doc.text(TICKET_PASS_COPY.qrInstructionLine1.toUpperCase(), w / 2, y, { align: 'center' });
  y += 11;
  doc.text(TICKET_PASS_COPY.qrInstructionLine2.toUpperCase(), w / 2, y, { align: 'center' });
  y += 14;

  const noticeLines = wrapPdfText(doc, TICKET_PASS_COPY.oktoberfestNoticeBody, inner - 24);
  const noticeHeight = 28 + noticeLines.length * 11;
  doc.setFillColor(...rgb(card));
  doc.roundedRect(pad, y, inner, noticeHeight, 8, 8, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...rgb(text));
  doc.text(TICKET_PASS_COPY.oktoberfestNoticeTitle.toUpperCase(), pad + 12, y + 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...rgb(muted));
  noticeLines.forEach((line, index) => {
    doc.text(line, pad + 12, y + 26 + index * 11);
  });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...rgb(subtle));
  doc.text(TICKET_PASS_COPY.footerLine1.toUpperCase(), w / 2, h - 32, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.text(TICKET_PASS_COPY.footerLine2.toUpperCase(), w / 2, h - 18, { align: 'center' });
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}

function cssRgb(color: TicketPassRgb) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

export function drawTicketPassPng(
  ctx: CanvasRenderingContext2D,
  model: TicketPassViewModel,
  assets: TicketPassExportAssets & { qrImage: CanvasImageSource; logoImage: CanvasImageSource | null },
) {
  const w = TICKET_PASS_PNG_SIZE.width;
  const h = TICKET_PASS_PNG_SIZE.height;
  const pad = 72;
  const inner = w - pad * 2;
  const { background, card, text, muted, subtle, white, success } = TICKET_PASS_NEUTRAL;

  ctx.fillStyle = cssRgb(background);
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = cssRgb(assets.accent);
  ctx.fillRect(0, 0, w, 14);

  let y = 72;

  if (assets.logoImage) {
    ctx.fillStyle = '#000';
    roundRect(ctx, pad, y, 128, 128, 28);
    ctx.drawImage(assets.logoImage, pad + 16, y + 16, 96, 96);
  }
  if (model.orderNumber) {
    ctx.fillStyle = cssRgb(subtle);
    ctx.font = '500 28px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(model.orderNumber, w - pad, y + 48);
    ctx.textAlign = 'left';
  }

  y += 168;
  ctx.fillStyle = cssRgb(assets.accentSoft);
  ctx.font = '700 22px sans-serif';
  ctx.fillText(TICKET_PASS_COPY.eyebrow.toUpperCase(), pad, y);

  y += 56;
  ctx.fillStyle = cssRgb(text);
  ctx.font = '700 64px sans-serif';
  wrapCanvasLines(ctx, model.eventName, inner, 3).forEach((line) => {
    ctx.fillText(line, pad, y);
    y += 72;
  });

  if (model.categoryName) {
    ctx.font = '700 36px sans-serif';
    wrapCanvasLines(ctx, model.categoryName.toUpperCase(), inner, 2).forEach((line) => {
      ctx.fillText(line, pad, y);
      y += 44;
    });
  }

  if (model.dateParts) {
    y += 28;
    ctx.font = '700 96px sans-serif';
    ctx.fillText(model.dateParts.day, pad, y);
    const dayWidth = ctx.measureText(model.dateParts.day).width;
    ctx.font = '700 28px sans-serif';
    ctx.fillStyle = cssRgb(assets.accentSoft);
    ctx.fillText(model.dateParts.month, pad + dayWidth + 24, y - 40);
    ctx.fillStyle = cssRgb(muted);
    ctx.fillText(model.dateParts.year, pad + dayWidth + 24, y);
    if (model.dateParts.time) {
      ctx.fillStyle = cssRgb(text);
      ctx.font = '700 40px sans-serif';
      ctx.fillText(model.dateParts.time, pad + dayWidth + 180, y - 8);
    }
    y += 36;
  }

  if (model.location) {
    y += 28;
    ctx.fillStyle = cssRgb(text);
    ctx.font = '500 32px sans-serif';
    wrapCanvasLines(ctx, model.location, inner, 2).forEach((line) => {
      ctx.fillText(line, pad, y);
      y += 40;
    });
  }

  const rows: Array<{ label: string; value: string; color: TicketPassRgb }> = [];
  if (model.holderName) rows.push({ label: TICKET_PASS_COPY.holderLabel, value: model.holderName, color: text });
  if (model.categoryName) rows.push({ label: TICKET_PASS_COPY.categoryLabel, value: model.categoryName, color: text });
  if (model.orderNumber) rows.push({ label: TICKET_PASS_COPY.orderLabel, value: model.orderNumber, color: text });
  rows.push({
    label: TICKET_PASS_COPY.statusLabel,
    value: model.statusIsActive ? TICKET_PASS_COPY.activeStatus : model.statusText,
    color: model.statusIsActive ? success : text,
  });

  y += 36;
  rows.forEach((row) => {
    ctx.fillStyle = cssRgb(card);
    roundRect(ctx, pad, y, inner, 96, 22);
    ctx.fillStyle = cssRgb(subtle);
    ctx.font = '700 18px sans-serif';
    ctx.fillText(row.label.toUpperCase(), pad + 28, y + 34);
    ctx.fillStyle = cssRgb(row.color);
    ctx.font = '700 30px sans-serif';
    const value = wrapCanvasLines(ctx, row.value, inner - 56, 1)[0] ?? '';
    ctx.fillText(value, pad + 28, y + 72);
    y += 112;
  });

  const qrOuter = Math.min(560, h - y - 360);
  const qrX = (w - qrOuter) / 2;
  y += 12;
  ctx.fillStyle = cssRgb(assets.accentSoft);
  ctx.font = '700 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(TICKET_PASS_COPY.qrPurpose.toUpperCase(), w / 2, y);
  ctx.textAlign = 'left';
  y += 28;
  ctx.fillStyle = cssRgb(assets.accent);
  roundRect(ctx, qrX, y, qrOuter, qrOuter, 40);
  ctx.fillStyle = cssRgb(white);
  roundRect(ctx, qrX + 12, y + 12, qrOuter - 24, qrOuter - 24, 32);
  ctx.drawImage(assets.qrImage, qrX + 36, y + 36, qrOuter - 72, qrOuter - 72);
  y += qrOuter + 48;

  ctx.fillStyle = cssRgb(muted);
  ctx.font = '700 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(TICKET_PASS_COPY.qrInstructionLine1.toUpperCase(), w / 2, y);
  ctx.fillText(TICKET_PASS_COPY.qrInstructionLine2.toUpperCase(), w / 2, y + 32);
  y += 64;

  const noticePadX = pad;
  const noticeWidth = inner;
  const noticeBodyLines = wrapCanvasLines(ctx, TICKET_PASS_COPY.oktoberfestNoticeBody, noticeWidth - 56, 3);
  const noticeHeight = 108 + noticeBodyLines.length * 28;
  ctx.fillStyle = cssRgb(card);
  roundRect(ctx, noticePadX, y, noticeWidth, noticeHeight, 22);
  ctx.fillStyle = cssRgb(text);
  ctx.font = '700 20px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(TICKET_PASS_COPY.oktoberfestNoticeTitle.toUpperCase(), noticePadX + 28, y + 40);
  ctx.fillStyle = cssRgb(muted);
  ctx.font = '500 22px sans-serif';
  noticeBodyLines.forEach((line, index) => {
    ctx.fillText(line, noticePadX + 28, y + 78 + index * 28);
  });

  ctx.fillStyle = cssRgb(subtle);
  ctx.font = '700 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(TICKET_PASS_COPY.footerLine1.toUpperCase(), w / 2, h - 80);
  ctx.font = '500 16px sans-serif';
  ctx.fillText(TICKET_PASS_COPY.footerLine2.toUpperCase(), w / 2, h - 48);
  ctx.textAlign = 'left';
}
