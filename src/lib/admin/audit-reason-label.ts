import { REASON_CODE_LABELS } from "@/app/operacoes/types";
import { sensitiveActionReasonLabel } from "@/lib/admin/sensitive-action-reasons";

/**
 * Motivo operacional já persistido em audit_logs.details.
 * Prefere o texto livre (reason_text / reason / review_notes) e, se só
 * houver código, o rótulo conhecido. Não inventa motivo.
 */
export function auditReasonFromDetails(details: Record<string, unknown> | null | undefined): string | null {
  if (!details) return null;
  for (const key of ["reason_text", "reason", "review_notes"] as const) {
    const value = String(details[key] ?? "").trim();
    if (value) return value;
  }
  const code = String(details.reason_code ?? "").trim();
  if (!code) return null;
  return (REASON_CODE_LABELS as Record<string, string>)[code] ?? sensitiveActionReasonLabel(code);
}
