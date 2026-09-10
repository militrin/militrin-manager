"use client";

import Link from "next/link";
import {
  compactInviteCenterMaskedEmail,
  INVITE_CENTER_STATUS_LABEL,
  INVITE_CENTER_STATUS_TONE,
} from "@/lib/invites/invite-center-status";
import { sharedEmailCompactMeta } from "@/lib/account/shared-email-ownership";
import { formatStackedDateTimeBR } from "@/lib/utils/date";
import { ADMIN_LIST_HEADER_CLASS, ADMIN_LIST_ROW_CLASS, ADMIN_LIST_ZEBRA_CLASS, adminTableRowProps } from "@/components/admin";
import type { InviteCenterListRow } from "@/lib/invites/invite-center-types";

const actionClass = "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg border border-slate-700 px-2.5 text-xs";
const DESKTOP_GRID = "lg:grid-cols-[minmax(0,1.7fr)_minmax(9.5rem,1fr)_minmax(0,0.9fr)_48px_4.5rem_4.5rem_minmax(9.75rem,0.95fr)_3.5rem]";

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
    <span className={`inline-flex max-w-full whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium ${className}`}>
      {INVITE_CENTER_STATUS_LABEL[status]}
    </span>
  );
}

function StackedDate({ value, todayLabel = false }: { value: string | null; todayLabel?: boolean }) {
  if (!value) return <span className="text-slate-500">—</span>;
  const parts = formatStackedDateTimeBR(value, { todayLabel });
  return (
    <time className="block leading-tight text-[11px] text-slate-300" dateTime={value} title={parts.title}>
      <span className="block">{parts.line1}</span>
      {parts.line2 ? <span className="block text-slate-400">{parts.line2}</span> : null}
    </time>
  );
}

function personSecondLine(row: InviteCenterListRow) {
  if (row.person_count > 1) return sharedEmailCompactMeta(row.person_count);
  return null;
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
      <div className={`hidden ${DESKTOP_GRID} gap-2 bg-slate-900 px-3 text-slate-400 lg:grid ${ADMIN_LIST_HEADER_CLASS}`}>
        <span>Pessoa</span>
        <span>Contato</span>
        <span>Evento</span>
        <span>Ingressos</span>
        <span>Envio</span>
        <span>Validade</span>
        <span>Situação</span>
        <span>Ação</span>
      </div>
      <div className={`${ADMIN_LIST_ZEBRA_CLASS}`}>
        {rows.map((row) => {
          const email = compactInviteCenterMaskedEmail(row.email_masked);
          const meta = personSecondLine(row);
          return (
            <div key={row.row_key} className={ADMIN_LIST_ROW_CLASS} {...adminTableRowProps()}>
              <div className={`hidden h-14 items-center gap-2 px-3 lg:grid ${DESKTOP_GRID}`}>
                <span className="min-w-0">
                  <span className="block truncate font-medium leading-5" title={row.principal_name || "Sem nome"}>{row.principal_name || "Sem nome"}</span>
                  {meta ? <span className="block truncate text-[11px] leading-4 text-slate-500" title={meta}>{meta}</span> : null}
                </span>
                <span className="min-w-0 truncate text-slate-300" title={email}>{email}</span>
                <span className="truncate" title={row.event_name || undefined}>{row.event_name || "—"}</span>
                <span className="whitespace-nowrap tabular-nums text-slate-300">{row.ticket_count}</span>
                <StackedDate value={row.sent_at} />
                <StackedDate value={row.expires_at} todayLabel />
                <span className="min-w-0 overflow-hidden"><StatusBadge status={row.status} /></span>
                <Link href={`/convites/${row.row_key}`} className={actionClass}>Abrir</Link>
              </div>

              <article className="space-y-2 px-3 py-3 lg:hidden">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-medium" title={row.principal_name || "Sem nome"}>{row.principal_name || "Sem nome"}</h3>
                    <p className="truncate text-xs text-slate-400" title={email}>{email}</p>
                    {meta ? <p className="truncate text-[11px] text-slate-500">{meta}</p> : null}
                  </div>
                  <StatusBadge status={row.status} />
                </div>
                <p className="text-xs text-slate-400">
                  Validade: {row.expires_at ? formatStackedDateTimeBR(row.expires_at, { todayLabel: true }).title : "—"}
                  {" · "}
                  {row.ticket_count} {row.ticket_count === 1 ? "ingresso" : "ingressos"}
                </p>
                <Link href={`/convites/${row.row_key}`} className={actionClass}>Abrir</Link>
              </article>
            </div>
          );
        })}
      </div>
    </div>
  );
}
