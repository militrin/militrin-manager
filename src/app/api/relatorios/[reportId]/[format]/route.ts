import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { runReport } from "@/lib/reports/run-report";
import { buildGenericReportPdf } from "@/lib/reports/generic-pdf";
import { buildGenericReportWorkbook } from "@/lib/reports/generic-xlsx";
import type { ReportResultSuccess } from "@/lib/reports/types";

// CSV: sem dependencia nova (XLSX/PDF ja cobrem a exportacao "limpa" pedida;
// CSV e so serializacao de texto). Excel abre CSV com BOM UTF-8 sem
// gambiarra de encoding; ";" como separador porque virgula colide com o
// separador decimal pt-BR quando o usuario abre no Excel local.
function csvEscape(value: string) {
  return /[;"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildGenericReportCsv(result: ReportResultSuccess) {
  const header = result.columns.map((column) => csvEscape(column.label)).join(";");
  const lines = result.rows.map((row) =>
    result.columns.map((column) => csvEscape(String(row[column.key] ?? ""))).join(";"),
  );
  return "﻿" + [header, ...lines].join("\r\n");
}

function maskEmail(email: string | undefined) {
  if (!email?.includes("@")) return "Operador autenticado";
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}***@${domain}`;
}

function sanitizedDate(value: string | null) {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function sanitizedUuid(value: string | null) {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}

const DIACRITICS_PATTERN = new RegExp("[\\u0300-\\u036f]", "g");
function normalizeSearch(value: string) {
  return value.normalize("NFD").replace(DIACRITICS_PATTERN, "").toLowerCase();
}

// Mesmo filtro de texto livre aplicado no preview (reports-explorer.tsx),
// reaplicado aqui pro export tambem respeitar a busca rapida ativa -- sem
// isso, "Exportação deve respeitar os filtros ativos" ficaria valendo so
// pra evento/periodo, nao pro campo de busca.
function applyQuickSearch(result: ReportResultSuccess, rawQuery: string | null): ReportResultSuccess {
  const query = normalizeSearch((rawQuery ?? "").trim().slice(0, 200));
  if (!query) return result;
  const rows = result.rows.filter((row) =>
    Object.values(row).some((value) => value !== null && normalizeSearch(String(value)).includes(query)),
  );
  return { ...result, rows, subtitle: `${result.subtitle} · filtro de busca: "${rawQuery?.trim().slice(0, 200)}"` };
}

export async function GET(request: Request, { params }: { params: Promise<{ reportId: string; format: string }> }) {
  const { reportId, format } = await params;
  if (format !== "pdf" && format !== "xlsx" && format !== "csv") return new NextResponse("Formato inválido", { status: 404 });

  const url = new URL(request.url);
  const eventId = sanitizedUuid(url.searchParams.get("eventId"));
  const dateFrom = sanitizedDate(url.searchParams.get("dateFrom"));
  const dateTo = sanitizedDate(url.searchParams.get("dateTo"));
  if (eventId === undefined || dateFrom === undefined || dateTo === undefined) {
    return new NextResponse("Filtros inválidos", { status: 400 });
  }

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Sessão expirada", { status: 401 });

  const rawResult = await runReport(reportId, { eventId, dateFrom, dateTo });
  if (!rawResult.success) return new NextResponse(rawResult.message, { status: 400 });
  const result = applyQuickSearch(rawResult, url.searchParams.get("q"));

  const generatedAt = new Date().toISOString();
  const generatedBy = maskEmail(user.email);
  const filenameBase = `relatorio-${reportId}`;

  if (format === "xlsx") {
    const buffer = await buildGenericReportWorkbook(result, generatedAt, generatedBy);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filenameBase}.xlsx"`,
      },
    });
  }

  if (format === "csv") {
    const csv = buildGenericReportCsv(result);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filenameBase}.csv"`,
      },
    });
  }

  const buffer = buildGenericReportPdf(result, generatedAt, generatedBy);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filenameBase}.pdf"`,
    },
  });
}
