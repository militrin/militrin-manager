import ExcelJS from "exceljs";
import { formatReportDateTime, REPORT_TIME_ZONE } from "./report-theme";
import type { ReportResultSuccess } from "./types";

const COLORS = { white: "FFFFFFFF", text: "FF1F2937", border: "FFD1D5DB", alternate: "FFF3F7F5", green: "FF047857" };

function bottomBorder(cell: ExcelJS.Cell) {
  cell.border = { bottom: { style: "thin", color: { argb: COLORS.border } } };
}

export async function buildGenericReportWorkbook(result: ReportResultSuccess, generatedAt: string, generatedBy: string) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Militrin";
  workbook.company = "Militrin";
  workbook.subject = result.title;
  workbook.created = new Date(generatedAt);
  workbook.modified = new Date(generatedAt);

  const summary = workbook.addWorksheet("Resumo", {
    properties: { defaultRowHeight: 20 },
    views: [{ showGridLines: false }],
  });
  summary.mergeCells("A1:D2");
  const title = summary.getCell("A1");
  title.value = result.title;
  title.font = { name: "Aptos Display", size: 18, bold: true, color: { argb: COLORS.white } };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.green } };
  title.alignment = { vertical: "middle", horizontal: "left" };
  summary.getRow(1).height = 26;
  summary.getRow(2).height = 16;

  const fields: Array<[string, string]> = [
    ["Filtros aplicados", result.subtitle],
    ["Gerado em", formatReportDateTime(generatedAt)],
    ["Responsável", generatedBy],
    ["Fuso horário", REPORT_TIME_ZONE],
  ];
  fields.forEach(([label, value], index) => {
    const row = summary.getRow(index + 4);
    row.getCell(1).value = label;
    row.getCell(1).font = { name: "Aptos", bold: true, color: { argb: COLORS.green } };
    row.getCell(2).value = value;
    summary.mergeCells(row.number, 2, row.number, 4);
    row.getCell(2).font = { name: "Aptos", color: { argb: COLORS.text } };
    row.getCell(2).alignment = { wrapText: true };
    row.height = 20;
    for (let column = 1; column <= 4; column += 1) bottomBorder(row.getCell(column));
  });

  if (result.summaryCards.length > 0) {
    const cardsHeaderRow = 4 + fields.length + 1;
    summary.getCell(`A${cardsHeaderRow}`).value = "Indicadores";
    summary.getCell(`A${cardsHeaderRow}`).font = { name: "Aptos", bold: true, size: 12, color: { argb: COLORS.text } };
    result.summaryCards.forEach((card, index) => {
      const row = summary.getRow(cardsHeaderRow + index + 1);
      row.getCell(1).value = card.label;
      row.getCell(1).font = { name: "Aptos", color: { argb: COLORS.green } };
      row.getCell(2).value = card.value;
      row.getCell(2).font = { name: "Aptos", bold: true, color: { argb: COLORS.text } };
      for (let column = 1; column <= 2; column += 1) bottomBorder(row.getCell(column));
    });
  }
  summary.columns = [{ width: 24 }, { width: 34 }, { width: 18 }, { width: 18 }];

  const dataSheet = workbook.addWorksheet("Dados", {
    properties: { defaultRowHeight: 20, outlineProperties: { summaryBelow: true, summaryRight: false } },
    views: [{ state: "frozen", ySplit: 1, activeCell: "A2", showGridLines: false }],
  });
  dataSheet.columns = result.columns.map((column) => ({ header: column.label, key: column.key, width: 24 }));
  const header = dataSheet.getRow(1);
  header.height = 24;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.green } };
    cell.font = { name: "Aptos", bold: true, color: { argb: COLORS.white } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  if (result.columns.length > 0) {
    dataSheet.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + result.columns.length)}1` };
  }

  result.rows.forEach((row, index) => {
    const addedRow = dataSheet.addRow(row);
    addedRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "Aptos", size: 10, color: { argb: COLORS.text } };
      cell.alignment = { vertical: "top", wrapText: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? COLORS.alternate : COLORS.white } };
      bottomBorder(cell);
    });
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
