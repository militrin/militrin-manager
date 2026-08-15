import type { createServerSupabaseClient } from "@/lib/supabase/server";

export type ReportSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export type ReportColumn = { key: string; label: string; align?: "left" | "right" };
export type ReportSummaryCard = { label: string; value: string };

export type ReportResultSuccess = {
  success: true;
  reportId: string;
  title: string;
  subtitle: string;
  generatedAt: string;
  summaryCards: ReportSummaryCard[];
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
  notice?: string;
};

export type ReportResultError = { success: false; message: string };

export type ReportResult = ReportResultSuccess | ReportResultError;

export type ReportQueryContext = {
  organizationId: string;
  eventId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
};
