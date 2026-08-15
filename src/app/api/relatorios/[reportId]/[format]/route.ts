import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { runReport } from "@/lib/reports/run-report";
import { buildGenericReportPdf } from "@/lib/reports/generic-pdf";
import { buildGenericReportWorkbook } from "@/lib/reports/generic-xlsx";

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

export async function GET(request: Request, { params }: { params: Promise<{ reportId: string; format: string }> }) {
  const { reportId, format } = await params;
  if (format !== "pdf" && format !== "xlsx") return new NextResponse("Formato inválido", { status: 404 });

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

  const result = await runReport(reportId, { eventId, dateFrom, dateTo });
  if (!result.success) return new NextResponse(result.message, { status: 400 });

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

  const buffer = buildGenericReportPdf(result, generatedAt, generatedBy);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filenameBase}.pdf"`,
    },
  });
}
