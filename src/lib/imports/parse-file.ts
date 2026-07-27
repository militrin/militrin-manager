import * as XLSX from 'xlsx';

export type ParsedSheet = {
  headers: string[];
  rows: Record<string, string>[];
};

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

  const headers = splitLine(lines[0]).map((header, index) => header || `coluna_${index + 1}`);
  const rows = lines.slice(1).map((line) => {
    const values = splitLine(line);
    return headers.reduce<Record<string, string>>((acc, header, index) => {
      acc[header] = String(values[index] ?? '').trim();
      return acc;
    }, {});
  });

  return { headers, rows };
}

function parseXlsx(buffer: ArrayBuffer): ParsedSheet {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });

  const headers = rows.length ? Object.keys(rows[0]) : [];
  const normalizedRows = rows.map((row) => {
    const next: Record<string, string> = {};
    for (const header of headers) {
      next[header] = String(row[header] ?? '').trim();
    }
    return next;
  });

  return { headers, rows: normalizedRows };
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
