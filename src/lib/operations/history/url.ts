import { HISTORY_CATEGORIES } from "./constants.ts";
import type { HistoryPeriodPreset, OperationHistoryCategory, OperationHistoryQueryInput } from "./types.ts";

const PERIODS = new Set<HistoryPeriodPreset>(["today", "yesterday", "7d", "30d", "custom"]);

export function parseHistorySearchParams(params: {
  eventId?: string;
  period?: string;
  dateFrom?: string;
  dateTo?: string;
  category?: string;
  operatorUserId?: string;
  search?: string;
  shirtType?: string;
  shirtSize?: string;
}): Pick<OperationHistoryQueryInput, "period" | "dateFrom" | "dateTo" | "category" | "operatorUserId" | "search" | "shirtType" | "shirtSize"> & { eventId?: string } {
  const period = PERIODS.has(params.period as HistoryPeriodPreset) ? params.period as HistoryPeriodPreset : "today";
  const category = HISTORY_CATEGORIES.includes(params.category as OperationHistoryCategory | "all")
    ? params.category as OperationHistoryCategory | "all"
    : "all";
  return {
    eventId: params.eventId?.trim() || undefined,
    period,
    dateFrom: params.dateFrom ?? null,
    dateTo: params.dateTo ?? null,
    category,
    operatorUserId: params.operatorUserId?.trim() || null,
    search: params.search?.trim() || null,
    shirtType: params.shirtType?.trim() || null,
    shirtSize: params.shirtSize?.trim() || null,
  };
}

export function shirtDeliveriesHref(input: {
  eventId: string;
  shirtType: string;
  shirtSize: string;
  period?: HistoryPeriodPreset;
}) {
  const params = new URLSearchParams({
    eventId: input.eventId,
    period: input.period ?? "today",
    category: "kit",
    shirtType: input.shirtType,
    shirtSize: input.shirtSize,
  });
  return `/operacoes/relatorio?${params.toString()}`;
}
