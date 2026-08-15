import { jsPDF } from "jspdf";
import { applyReportPage, finalizeReportPages, formatReportDateTime, REPORT_THEME } from "./report-theme";
import type { ReportResultSuccess } from "./types";

const ROW_HEIGHT = 16;
const CARD_HEIGHT = 40;

function truncate(doc: jsPDF, text: string, maxWidth: number) {
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && doc.getTextWidth(`${truncated}…`) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

export function buildGenericReportPdf(result: ReportResultSuccess, generatedAt: string, generatedBy: string): Buffer {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const { page, colors } = REPORT_THEME;
  const contentWidth = page.width - page.marginX * 2;
  const bottomLimit = page.height - page.bottom - 30;
  let y = page.top + 20;

  const newPage = () => {
    doc.addPage();
    applyReportPage(doc, result.title);
    y = page.top + 20;
  };

  applyReportPage(doc, result.title);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...colors.muted);
  doc.text(result.subtitle, page.marginX, y);
  y += 24;

  if (result.summaryCards.length > 0) {
    const perRow = Math.min(3, result.summaryCards.length);
    const gap = 10;
    const cardWidth = (contentWidth - gap * (perRow - 1)) / perRow;
    result.summaryCards.forEach((card, index) => {
      const column = index % perRow;
      if (column === 0 && index > 0) y += CARD_HEIGHT + gap;
      if (y + CARD_HEIGHT > bottomLimit) newPage();
      const x = page.marginX + column * (cardWidth + gap);
      doc.setFillColor(...colors.card);
      doc.setDrawColor(...colors.border);
      doc.roundedRect(x, y, cardWidth, CARD_HEIGHT, 6, 6, "FD");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...colors.subtle);
      doc.text(truncate(doc, card.label.toUpperCase(), cardWidth - 16), x + 8, y + 15);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(...colors.text);
      doc.text(truncate(doc, card.value, cardWidth - 16), x + 8, y + 31);
    });
    y += CARD_HEIGHT + 28;
  }

  if (result.columns.length > 0) {
    const colWidth = contentWidth / result.columns.length;

    const drawHeader = () => {
      doc.setFillColor(...colors.green);
      doc.rect(page.marginX, y, contentWidth, ROW_HEIGHT + 4, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...colors.white);
      result.columns.forEach((column, index) => {
        const x = page.marginX + index * colWidth + 6;
        doc.text(truncate(doc, column.label, colWidth - 10), x, y + ROW_HEIGHT - 2);
      });
      y += ROW_HEIGHT + 4;
    };

    if (y + ROW_HEIGHT * 2 > bottomLimit) newPage();
    drawHeader();

    result.rows.forEach((row, rowIndex) => {
      if (y + ROW_HEIGHT > bottomLimit) {
        newPage();
        drawHeader();
      }
      if (rowIndex % 2 === 1) {
        doc.setFillColor(...colors.card);
        doc.rect(page.marginX, y, contentWidth, ROW_HEIGHT, "F");
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...colors.text);
      result.columns.forEach((column, index) => {
        const value = row[column.key];
        const text = value === null || value === undefined ? "-" : String(value);
        const x = page.marginX + index * colWidth + 6;
        doc.text(truncate(doc, text, colWidth - 10), x, y + ROW_HEIGHT - 5);
      });
      y += ROW_HEIGHT;
    });

    if (result.rows.length === 0) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...colors.subtle);
      doc.text("Nenhum dado encontrado para os filtros selecionados.", page.marginX, y + 14);
    }
  }

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(...colors.subtle);
  doc.text(`Responsável: ${generatedBy}`, page.marginX, page.height - page.bottom - 8);

  finalizeReportPages(doc, generatedAt, `Militrin · ${formatReportDateTime(generatedAt)}`);
  return Buffer.from(doc.output("arraybuffer"));
}
