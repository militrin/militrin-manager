import type { ParticipationEntry } from "./types";

const REQUIRED_COLUMNS = ["comment_id", "username", "comment"] as const;
const KNOWN_COLUMNS = [
  "entry_number",
  "comment_id",
  "username",
  "comment",
  "mentions_count",
  "mentions",
  "comment_url",
  "chance",
] as const;

export type CsvImportResult =
  | { success: true; entries: ParticipationEntry[]; summary: CsvImportSummary }
  | { success: false; error: string };

export type CsvImportSummary = {
  totalRows: number;
  imported: number;
  emptyRowsSkipped: number;
  duplicateCommentIdsSkipped: number;
  invalidRowsSkipped: number;
};

// Parser RFC4180: precisa suportar campos entre aspas com vírgulas, aspas
// escapadas ("") e quebras de linha internas, porque o texto de comentários
// do Instagram frequentemente contém todos os três.
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }

    if (char === "\r") {
      i += 1;
      continue;
    }

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/^﻿/, "");
}

export function parseSorteioCsv(text: string): CsvImportResult {
  const rows = parseCsvText(text).filter((r) => !(r.length === 1 && r[0].trim() === ""));
  if (rows.length === 0) {
    return { success: false, error: "O arquivo está vazio ou não pôde ser lido." };
  }

  const header = rows[0].map(normalizeHeader);
  const columnIndex = new Map<string, number>();
  header.forEach((name, index) => {
    if ((KNOWN_COLUMNS as readonly string[]).includes(name)) columnIndex.set(name, index);
  });

  const missing = REQUIRED_COLUMNS.filter((col) => !columnIndex.has(col));
  if (missing.length > 0) {
    return {
      success: false,
      error: `Estrutura do CSV inválida. Colunas obrigatórias ausentes: ${missing.join(", ")}.`,
    };
  }

  const dataRows = rows.slice(1);
  const seenCommentIds = new Set<string>();
  const entries: ParticipationEntry[] = [];

  let emptyRowsSkipped = 0;
  let duplicateCommentIdsSkipped = 0;
  let invalidRowsSkipped = 0;

  const get = (row: string[], col: (typeof KNOWN_COLUMNS)[number]) => {
    const idx = columnIndex.get(col);
    if (idx === undefined) return "";
    return (row[idx] ?? "").trim();
  };

  dataRows.forEach((row, i) => {
    const isFullyEmpty = row.every((cell) => cell.trim() === "");
    if (isFullyEmpty) {
      emptyRowsSkipped += 1;
      return;
    }

    const commentId = get(row, "comment_id");
    const username = get(row, "username");
    const comment = get(row, "comment");

    if (!commentId || !username) {
      invalidRowsSkipped += 1;
      return;
    }

    if (seenCommentIds.has(commentId)) {
      duplicateCommentIdsSkipped += 1;
      return;
    }
    seenCommentIds.add(commentId);

    const entryNumberRaw = get(row, "entry_number");
    const entryNumber = Number.parseInt(entryNumberRaw, 10);
    const mentionsCountRaw = get(row, "mentions_count");
    const mentionsCountParsed = Number.parseInt(mentionsCountRaw, 10);

    entries.push({
      entryNumber: Number.isFinite(entryNumber) ? entryNumber : i + 1,
      commentId,
      username,
      comment,
      mentionsCount: Number.isFinite(mentionsCountParsed) ? mentionsCountParsed : null,
      mentions: get(row, "mentions"),
      commentUrl: get(row, "comment_url"),
      commentCreatedAt: null,
      chance: get(row, "chance"),
      status: "active",
    });
  });

  if (entries.length === 0) {
    return { success: false, error: "Nenhuma entrada válida foi encontrada no arquivo." };
  }

  return {
    success: true,
    entries,
    summary: {
      totalRows: dataRows.length,
      imported: entries.length,
      emptyRowsSkipped,
      duplicateCommentIdsSkipped,
      invalidRowsSkipped,
    },
  };
}
