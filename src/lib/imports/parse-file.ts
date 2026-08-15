import * as XLSX from 'xlsx';

export type ParsedSheet = {
  headers: string[];
  rows: Record<string, string>[];
};

const EMPTY_XLSX_HEADER = /^__EMPTY(?:_\d+)?$/i;

export function parseSpreadsheetMatrix(matrix: unknown[][]): ParsedSheet {
  const headerRowIndex = matrix.findIndex((row) =>
    row.some((value) => String(value ?? '').trim().length > 0),
  );
  if (headerRowIndex < 0) return { headers: [], rows: [] };

  const rawHeaders = matrix[headerRowIndex].map((value) => String(value ?? '').trim());
  const dataRows = matrix.slice(headerRowIndex + 1);
  const usefulColumns = rawHeaders
    .map((header, index) => ({ header, index }))
    .filter(({ header, index }) =>
      header.length > 0
      && !EMPTY_XLSX_HEADER.test(header)
      && dataRows.some((row) => String(row[index] ?? '').trim().length > 0),
    );

  const headerCounts = new Map<string, number>();
  for (const { header } of usefulColumns) {
    const key = header.toLocaleLowerCase('pt-BR');
    headerCounts.set(key, (headerCounts.get(key) ?? 0) + 1);
  }

  const columns = usefulColumns.map(({ header, index }) => ({
    index,
    header: (headerCounts.get(header.toLocaleLowerCase('pt-BR')) ?? 0) > 1
      ? `${header} (coluna ${index + 1})`
      : header,
  }));
  const headers = columns.map(({ header }) => header);
  const rows = dataRows
    .filter((row) => columns.some(({ index }) => String(row[index] ?? '').trim().length > 0))
    .map((row) => Object.fromEntries(
      columns.map(({ header, index }) => [header, String(row[index] ?? '').trim()]),
    ));

  return { headers, rows };
}

function parseCsv(content: string): ParsedSheet {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (!lines.length) return { headers: [], rows: [] };

  const splitLine = (line: string) => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
  };

  return parseSpreadsheetMatrix(lines.map(splitLine));
}

function parseXlsx(buffer: ArrayBuffer): ParsedSheet {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [] };
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: false,
  });

  return parseSpreadsheetMatrix(matrix);
}

export async function parseSpreadsheetFile(file: File): Promise<ParsedSheet> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.csv')) {
    const text = await file.text();
    return parseCsv(text);
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const buffer = await file.arrayBuffer();
    return parseXlsx(buffer);
  }

  throw new Error('Formato nao suportado. Envie CSV ou XLSX.');
}
