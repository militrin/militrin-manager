import { NextResponse } from "next/server";
import { hasPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAdministrativeTicketTimeline, ticketTimelineToCsv, ticketTimelineToPdf } from "@/lib/admin/ticket-timeline";
import { ticketTimelineToXlsx } from "@/lib/reports/ticket-timeline-xlsx";

function maskEmail(email: string | undefined) { if (!email?.includes("@")) return "Operador autenticado"; const [name,domain]=email.split("@"); return `${name.slice(0,2)}***@${domain}`; }
function sanitizedDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value ? undefined : null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0,10) !== value ? undefined : value;
}
function sanitizedUuid(value: string | null) {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}

export async function GET(request: Request, { params }: { params: Promise<{ ticketId: string; format: string }> }) {
  const { ticketId, format } = await params;
  if (!await hasPermission("orders.view") && !await hasPermission("participants.view")) return new NextResponse("Acesso negado", { status: 403 });
  if (!['pdf','csv','xlsx'].includes(format)) return new NextResponse("Formato inválido", { status: 404 });
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) return new NextResponse("Organização não selecionada", { status: 403 });
  const url = new URL(request.url); const supabase = await createServerSupabaseClient();
  const rawScope = url.searchParams.get('scope');
  if (rawScope && rawScope !== 'ticket' && rawScope !== 'account') return new NextResponse("Escopo inválido", { status: 400 });
  const scope = rawScope === 'account' ? 'account' : 'ticket';
  const from = sanitizedDate(url.searchParams.get('from'));
  const to = sanitizedDate(url.searchParams.get('to'));
  const eventId = sanitizedUuid(url.searchParams.get('eventId'));
  const rawType = url.searchParams.get('type');
  if (from === undefined || to === undefined || eventId === undefined || (from && to && from > to) || (eventId && scope !== 'account') || (rawType && (rawType.length > 100 || !/^[a-z0-9_.:-]+$/.test(rawType)))) return new NextResponse("Filtros inválidos", { status: 400 });
  const { data: { user } } = await supabase.auth.getUser(); if (!user) return new NextResponse("Sessão expirada", { status: 401 });
  try {
    const canViewTechnicalAudit = await hasPermission('audit.view');
    const result = await getAdministrativeTicketTimeline(supabase, ticketId, organization.id, { from:from??undefined,to:to??undefined,type:rawType??undefined,scope,eventId:eventId??undefined,canViewTechnicalAudit,page:1,pageSize:5000 });
    if ((rawType && result.appliedTypeCode !== rawType) || (eventId && result.appliedEventId !== eventId)) return new NextResponse("Filtros inválidos", { status: 400 });
    const { data: auditRows, error: auditError } = await supabase.rpc('record_ticket_history_export', {
      p_ticket_id:ticketId,
      p_format:format,
      p_scope:result.scope,
      p_from:from,
      p_to:to,
      p_type:result.appliedTypeCode,
      p_filter_event_id:result.appliedEventId,
    });
    const audit = Array.isArray(auditRows) ? auditRows[0] : auditRows;
    if (auditError || !audit?.audit_id || !audit?.audited_at) return new NextResponse("Não foi possível auditar a exportação", { status: 500 });
    const generatedAt = String(audit.audited_at); const generatedBy = maskEmail(user.email);
    const filenameReference = result.header.ticketReference.replace(/[^0-9A-Za-z-]/g, '');
    if (format==='csv') return new NextResponse(ticketTimelineToCsv(result,generatedAt,generatedBy),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="historico-${filenameReference}.csv"`}});
    if (format==='xlsx') return new NextResponse(await ticketTimelineToXlsx(result,generatedAt,generatedBy),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="historico-${filenameReference}.xlsx"`}});
    return new NextResponse(ticketTimelineToPdf(result,generatedAt,generatedBy),{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="historico-${filenameReference}.pdf"`}});
  } catch (error) { return new NextResponse(error instanceof Error?error.message:"Falha ao gerar histórico",{status:404}); }
}
