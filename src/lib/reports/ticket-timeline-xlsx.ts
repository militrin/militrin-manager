import ExcelJS from "exceljs";
import type { TicketTimelineEvent, TicketTimelineResult } from "../admin/ticket-timeline.ts";
import { formatReportDateTime, reportIsoDateTime, reportSpreadsheetDate, REPORT_TIME_ZONE } from "./report-theme.ts";

const COLORS = { white: "FFFFFFFF", text: "FF1F2937", border: "FFD1D5DB", alternate: "FFF3F7F5", green: "FF047857" };

function allEvents(result: TicketTimelineResult) {
  return result.canViewTechnicalAudit ? [...result.events, ...result.technicalEvents] : result.events;
}

function resolvedEventName(result: TicketTimelineResult, item: TicketTimelineEvent) {
  return result.availableEvents.find((event) => event.id === item.eventId)?.name
    ?? (item.eventId === result.header.eventId ? result.header.eventName : "Evento identificado tecnicamente");
}

function bottomBorder(cell: ExcelJS.Cell) {
  cell.border = { bottom: { style: "thin", color: { argb: COLORS.border } } };
}

export async function ticketTimelineToXlsx(result: TicketTimelineResult, generatedAt: string, generatedBy: string) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Militrin";
  workbook.company = "Militrin";
  workbook.subject = "Histórico administrativo";
  workbook.created = new Date(generatedAt);
  workbook.modified = new Date(generatedAt);

  const summary = workbook.addWorksheet("Resumo", {
    properties: { defaultRowHeight: 20 },
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.65, bottom: 0.65, header: 0.25, footer: 0.25 } },
    views: [{ showGridLines: false }],
  });
  summary.mergeCells("A1:F2");
  const title = summary.getCell("A1");
  title.value = "Histórico administrativo Militrin";
  title.font = { name: "Aptos Display", size: 20, bold: true, color: { argb: COLORS.white } };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.green } };
  title.alignment = { vertical: "middle", horizontal: "left" };
  summary.getRow(1).height = 28;
  summary.getRow(2).height = 18;

  const eventFilter = result.scope === "account"
    ? result.appliedEventId ? result.header.filteredEventName ?? "Evento filtrado" : "Todos os eventos"
    : result.header.eventName;
  const fields: Array<[string, string | Date]> = [
    ["Escopo", result.scope === "account" ? "Conta inteira" : "Este ingresso"],
    ["Filtro de evento", eventFilter],
    ["Filtro de tipo", result.appliedTypeLabel ?? "Todos os tipos"],
    ["Conta / titular", result.header.holderName],
    ["Ingresso", result.scope === "ticket" ? result.header.ticketId : "Não se aplica ao escopo da conta"],
    ["Evento", eventFilter],
    ["Pedido", result.scope === "ticket" ? result.header.orderNumber : "Não se aplica ao escopo da conta"],
    ["Status", result.scope === "ticket" ? result.header.status : "Não se aplica ao escopo da conta"],
    ["Gerado em", reportSpreadsheetDate(generatedAt) ?? formatReportDateTime(generatedAt)],
    ["Responsável", generatedBy],
    ["Fuso horário", REPORT_TIME_ZONE],
  ];
  fields.forEach(([label, value], index) => {
    const rowNumber = index + 4;
    const row = summary.getRow(rowNumber);
    row.getCell(1).value = label;
    row.getCell(1).font = { name: "Aptos", bold: true, color: { argb: COLORS.green } };
    row.getCell(2).value = value;
    summary.mergeCells(rowNumber, 2, rowNumber, 6);
    row.getCell(2).font = { name: label === "Ingresso" ? "Consolas" : "Aptos", color: { argb: COLORS.text } };
    row.getCell(2).alignment = { vertical: "middle", wrapText: true };
    row.height = label === "Ingresso" ? 32 : 23;
    for (let column = 1; column <= 6; column += 1) bottomBorder(row.getCell(column));
  });
  summary.getCell("B12").numFmt = "dd/mm/yyyy hh:mm:ss";
  summary.columns = [{ width: 22 }, { width: 25 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }];
  summary.headerFooter.oddHeader = "&LMilitrin&CResumo do histórico&RRelatório administrativo";
  summary.headerFooter.oddFooter = "&LGerado em São Paulo&CConfidencial&R Página &P de &N";

  const history = workbook.addWorksheet("Histórico", {
    properties: { defaultRowHeight: 34, outlineProperties: { summaryBelow: true, summaryRight: false } },
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: "1:1", margins: { left: 0.35, right: 0.35, top: 0.55, bottom: 0.55, header: 0.2, footer: 0.2 } },
    views: [{ state: "frozen", ySplit: 1, activeCell: "A2", showGridLines: false }],
  });
  history.columns = [
    { header: "Data/hora", key: "occurredAt", width: 22 },
    { header: "Tipo", key: "typeLabel", width: 28 },
    { header: "Descrição", key: "description", width: 44 },
    { header: "Estado anterior", key: "previousState", width: 18 },
    { header: "Estado novo", key: "newState", width: 18 },
    { header: "Operador", key: "operator", width: 25 },
    { header: "Motivo", key: "reason", width: 32 },
    { header: "Alteração", key: "detail", width: 34 },
    { header: "Evento", key: "eventName", width: 28 },
    { header: "Ingresso", key: "ticketReference", width: 38 },
    { header: "Pedido", key: "orderReference", width: 22 },
    { header: "Data/hora ISO", key: "occurredAtIso", width: 26, hidden: true, outlineLevel: 1 },
    { header: "Código do tipo", key: "typeCode", width: 30, hidden: true, outlineLevel: 1 },
    { header: "Categoria", key: "category", width: 18, hidden: true, outlineLevel: 1 },
    { header: "Origem", key: "source", width: 14, hidden: true, outlineLevel: 1 },
    { header: "Evento ID", key: "eventId", width: 38, hidden: true, outlineLevel: 1 },
    { header: "Ingresso ID", key: "ticketId", width: 38, hidden: true, outlineLevel: 1 },
    { header: "Pedido ID", key: "orderId", width: 38, hidden: true, outlineLevel: 1 },
  ];
  const header = history.getRow(1);
  header.height = 28;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.green } };
    cell.font = { name: "Aptos", bold: true, color: { argb: COLORS.white } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  history.autoFilter = { from: "A1", to: "R1" };

  allEvents(result).forEach((item, index) => {
    const row = history.addRow({
      occurredAt: reportSpreadsheetDate(item.occurredAt), typeLabel: item.label, description: item.description ?? "",
      previousState: item.hasTransition ? item.previousState ?? "" : "", newState: item.hasTransition ? item.newState ?? "" : "",
      operator: item.operator, reason: item.reason ?? "", detail: item.detail ?? "", eventName: resolvedEventName(result, item),
      ticketReference: item.relatedTicketId ?? "", orderReference: item.relatedOrderId ?? "", occurredAtIso: reportIsoDateTime(item.occurredAt),
      typeCode: item.type, category: item.category ?? "", source: item.source, eventId: item.eventId ?? "",
      ticketId: item.relatedTicketId ?? "", orderId: item.relatedOrderId ?? "",
    });
    row.height = 42;
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      cell.font = { name: column >= 16 || column === 10 ? "Consolas" : "Aptos", size: 10, color: { argb: COLORS.text } };
      cell.alignment = { vertical: "top", wrapText: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? COLORS.alternate : COLORS.white } };
      bottomBorder(cell);
    });
    row.getCell(1).numFmt = "dd/mm/yyyy hh:mm:ss";
  });
  history.headerFooter.oddHeader = "&LMilitrin&CHistórico administrativo&R&F";
  history.headerFooter.oddFooter = "&LGerado em São Paulo&CConfidencial&R Página &P de &N";
  history.pageSetup.printArea = `A1:K${Math.max(2, history.rowCount)}`;

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
