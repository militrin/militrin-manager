"use client";

import Link from "next/link";
import {
  INVITE_CENTER_STATUS_LABEL,
  INVITE_CENTER_STATUS_TONE,
  inviteCenterFirstAccessLabel,
} from "@/lib/invites/invite-center-status";
import { sharedEmailCompactMeta, sharedEmailPrincipalCompactLabel } from "@/lib/account/shared-email-ownership";
import { formatDateTimeCompactBR } from "@/lib/utils/date";
import { ADMIN_LIST_HEADER_CLASS, ADMIN_LIST_ROW_CLASS, ADMIN_LIST_ZEBRA_CLASS, adminTableRowProps } from "@/components/admin";
import type { InviteCenterListRow } from "@/lib/invites/invite-center-types";

const actionClass = "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg border border-slate-700 px-2.5 text-xs";
const DESKTOP_GRID = "lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_minmax(0,1fr)_78px_92px_92px_118px_118px_56px]";

function StatusBadge({ status }: { status: InviteCenterListRow["status"] }) {
  const tone = INVITE_CENTER_STATUS_TONE[status];
  const className = {
    default: "border-slate-600 bg-slate-800/70 text-slate-200",
    success: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
    warning: "border-amber-500/40 bg-amber-500/15 text-amber-200",
    danger: "border-rose-500/40 bg-rose-500/15 text-rose-200",
    info: "border-cyan-500/40 bg-cyan-500/15 text-cyan-200",
  }[tone];
  return (
    <span className={`inline-flex max-w-full truncate rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}>
      {INVITE_CENTER_STATUS_LABEL[status]}
    </span>
  );
}

export function InviteCenterList({
  rows,
  canResend: _canResend,
}: {
  rows: InviteCenterListRow[];
  canResend: boolean;
}) {
  if (!rows.length) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 text-sm">
      <div className={`hidden grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_minmax(0,1fr)_78px_92px_92px_118px_118px_56px] gap-2 bg-slate-900 px-3 text-slate-400 lg:grid ${ADMIN_LIST_HEADER_CLASS}`}>
        <span>Pessoa</span>
        <span>E-mail</span>
        <span>Evento</span>
        <span>Ingressos</span>
        <span>Enviado</span>
        <span>Validade</span>
        <span>Status</span>
        <span>Primeiro acesso</span>
        <span>Ações</span>
      </div>
      <div className={`${ADMIN_LIST_ZEBRA_CLASS}`}>
        {rows.map((row) => {
          const firstAccess = inviteCenterFirstAccessLabel(row.status, row.cadastral_incomplete);
          const principalCompact = row.person_count > 1 ? sharedEmailPrincipalCompactLabel(row.principal_name) : null;
          return (
            <div key={row.row_key} className={ADMIN_LIST_ROW_CLASS} {...adminTableRowProps()}>
              <div className={`hidden h-16 items-center gap-2 px-3 lg:grid ${DESKTOP_GRID}`}>
                <span className="min-w-0">
                  <span className="block truncate font-medium" title={row.principal_name || "Sem nome"}>{row.principal_name || "Sem nome"}</span>
                  {principalCompact ? <span className="block truncate text-[11px] text-slate-500" title={principalCompact}>{principalCompact}</span> : null}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-slate-300" title={row.email_masked}>{row.email_masked}</span>
                  {row.person_count > 1 ? <span className="block truncate text-[11px] text-slate-500">{sharedEmailCompactMeta(row.person_count)}</span> : null}
                </span>
                <span className="truncate" title={row.event_name || undefined}>{row.event_name || "—"}</span>
                <span className="whitespace-nowrap text-slate-300">{row.ticket_count} {row.ticket_count === 1 ? "ingresso" : "ingressos"}</span>
                <span className="whitespace-nowrap text-slate-300">{row.sent_at ? formatDateTimeCompactBR(row.sent_at) : "—"}</span>
                <span className="whitespace-nowrap text-slate-300">{row.expires_at ? formatDateTimeCompactBR(row.expires_at) : "—"}</span>
                <span className="min-w-0"><StatusBadge status={row.status} /></span>
                <span className="truncate text-xs text-slate-400" title={firstAccess}>{firstAccess}</span>
                <Link href={`/convites/${row.row_key}`} className={actionClass}>Abrir</Link>
              </div>

              <article className="space-y-2 px-3 py-3 lg:hidden">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-medium" title={row.principal_name || "Sem nome"}>{row.principal_name || "Sem nome"}</h3>
                    <p className="truncate text-xs text-slate-400" title={row.email_masked}>{row.email_masked}</p>
                    {row.person_count > 1 ? <p className="text-[11px] text-slate-500">{sharedEmailCompactMeta(row.person_count)}{principalCompact ? ` · ${principalCompact}` : ""}</p> : null}
                  </div>
                  <StatusBadge status={row.status} />
                </div>
                <p className="text-xs text-slate-400">{row.event_name || "Sem evento"} · {row.ticket_count} {row.ticket_count === 1 ? "ingresso" : "ingressos"}</p>
                <p className="text-xs text-slate-400">Enviado: {row.sent_at ? formatDateTimeCompactBR(row.sent_at) : "—"} · Válido até: {row.expires_at ? formatDateTimeCompactBR(row.expires_at) : "—"}</p>
                <p className="text-xs text-slate-500">{firstAccess}</p>
                <Link href={`/convites/${row.row_key}`} className={actionClass}>Abrir</Link>
              </article>
            </div>
          );
        })}
      </div>
    </div>
  );
}
