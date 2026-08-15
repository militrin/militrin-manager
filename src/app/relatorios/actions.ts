"use server";

import { runReport, type ReportFilters } from "@/lib/reports/run-report";
import type { ReportResult } from "@/lib/reports/types";

export async function getReportPreviewAction(reportId: string, filters: ReportFilters): Promise<ReportResult> {
  return runReport(reportId, filters);
}
