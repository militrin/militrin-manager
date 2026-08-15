import type { jsPDF } from "jspdf";

export const REPORT_TIME_ZONE = "America/Sao_Paulo";

export const REPORT_THEME = {
  page: { width: 595.28, height: 841.89, marginX: 42, top: 42, bottom: 48 },
  colors: {
    white: [255, 255, 255] as const,
    text: [31, 41, 55] as const,
    muted: [75, 85, 99] as const,
    subtle: [107, 114, 128] as const,
    border: [209, 213, 219] as const,
    card: [249, 250, 251] as const,
    green: [4, 120, 87] as const,
    greenSoft: [236, 253, 245] as const,
  },
} as const;

function dateParts(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: REPORT_TIME_ZONE,
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} às ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function reportSpreadsheetDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return new Date(Date.UTC(number("year"), number("month") - 1, number("day"), number("hour"), number("minute"), number("second")));
}

export function formatReportDateTime(value: string | Date | null | undefined) {
  if (!value) return "Data não informada";
  return dateParts(value) ?? "Data inválida";
}

export function reportIsoDateTime(value: string | Date | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toISOString();
}

export function splitTechnicalIdentifier(value: string, chunkSize = 18) {
  const safe = String(value ?? "");
  return safe.match(new RegExp(`.{1,${Math.max(8, chunkSize)}}`, "g")) ?? [safe];
}

export function applyReportPage(doc: jsPDF, title: string) {
  const { page, colors } = REPORT_THEME;
  doc.setFillColor(...colors.white);
  doc.rect(0, 0, page.width, page.height, "F");
  doc.setDrawColor(...colors.green);
  doc.setLineWidth(2);
  doc.line(page.marginX, 29, page.width - page.marginX, 29);
  doc.setTextColor(...colors.text);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(title, page.marginX, page.top);
}

export function finalizeReportPages(doc: jsPDF, generatedAt: string, footerLabel = "Militrin") {
  const { page, colors } = REPORT_THEME;
  const total = doc.getNumberOfPages();
  for (let current = 1; current <= total; current += 1) {
    doc.setPage(current);
    doc.setDrawColor(...colors.border);
    doc.setLineWidth(0.5);
    doc.line(page.marginX, page.height - 35, page.width - page.marginX, page.height - 35);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...colors.subtle);
    doc.text(`${footerLabel} · Gerado em ${formatReportDateTime(generatedAt)}`, page.marginX, page.height - 21);
    doc.text(`Página ${current} de ${total}`, page.width - page.marginX, page.height - 21, { align: "right" });
  }
}
