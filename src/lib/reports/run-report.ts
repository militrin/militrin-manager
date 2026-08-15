import { hasPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { REPORT_CATALOG } from "./catalog";
import { REPORT_REGISTRY } from "./registry";
import type { ReportResult } from "./types";

export type ReportFilters = { eventId?: string | null; dateFrom?: string | null; dateTo?: string | null };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string | null | undefined) {
  if (!value) return true;
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function runReport(reportId: string, filters: ReportFilters): Promise<ReportResult> {
  const definition = REPORT_CATALOG.find((report) => report.id === reportId);
  if (!definition) return { success: false, message: "Relatório não encontrado." };

  const permissions = Array.isArray(definition.permission) ? definition.permission : [definition.permission];
  let authorized = false;
  for (const code of permissions) {
    if (await hasPermission(code)) {
      authorized = true;
      break;
    }
  }
  if (!authorized) return { success: false, message: "Você não tem permissão para ver este relatório." };

  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) return { success: false, message: "Selecione uma organização." };

  if (!validDate(filters.dateFrom) || !validDate(filters.dateTo)) {
    return { success: false, message: "Informe datas validas no formato AAAA-MM-DD." };
  }
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
    return { success: false, message: "A data inicial nao pode ser posterior a data final." };
  }

  if (definition.needsEvent === "required" && !filters.eventId) {
    return { success: false, message: "Este relatório exige selecionar um evento." };
  }

  const queryFn = REPORT_REGISTRY[reportId];
  if (!queryFn) return { success: false, message: "Relatório ainda não implementado." };

  const supabase = await createServerSupabaseClient();
  return queryFn(supabase, {
    organizationId: organization.id,
    eventId: filters.eventId ?? null,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
  });
}
