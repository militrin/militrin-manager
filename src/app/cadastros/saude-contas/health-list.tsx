"use client";

import Link from "next/link";
import {
  ACCOUNT_HEALTH_STATE_LABEL,
  ACCOUNT_HEALTH_STATE_TONE,
  accountHealthCaseHref,
  type AccountHealthListRow,
} from "@/lib/account/account-health";
import { formatStackedDateTimeBR } from "@/lib/utils/date";
import { ADMIN_LIST_HEADER_CLASS, ADMIN_LIST_ROW_CLASS, ADMIN_LIST_ZEBRA_CLASS } from "@/components/admin";

const actionClass = "inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-700 px-3 text-sm";
const DESKTOP_GRID = "lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(9rem,0.9fr)_minmax(7rem,0.7fr)_minmax(8rem,0.8fr)_5.5rem]";

function StatusBadge({ state }: { state: AccountHealthListRow["state"] }) {
  const tone = ACCOUNT_HEALTH_STATE_TONE[state];
  const className = {
    default: "border-slate-600 bg-slate-800/70 text-slate-200",
    success: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
    warning: "border-amber-500/40 bg-amber-500/15 text-amber-200",
    danger: "border-rose-500/40 bg-rose-500/15 text-rose-200",
    info: "border-cyan-500/40 bg-cyan-500/15 text-cyan-200",
  }[tone];
  return (
    <span className={`inline-flex max-w-full rounded-full border px-2 py-0.5 text-[11px] font-medium ${className}`}>
      {ACCOUNT_HEALTH_STATE_LABEL[state]}
    </span>
  );
}

function presence(row: AccountHealthListRow) {
  const parts = [
    row.has_registration ? "Cadastro" : null,
    row.auth_confirmed === true ? "Conta confirmada" : row.auth_confirmed === false ? "Conta pendente" : "Sem conta",
    row.has_participant ? "Participação" : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function AccountHealthList({ rows }: { rows: AccountHealthListRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 text-sm">
      <div className={`hidden ${DESKTOP_GRID} gap-2 bg-slate-900 px-3 text-slate-400 lg:grid ${ADMIN_LIST_HEADER_CLASS}`}>
        <span>Pessoa</span>
        <span>E-mail</span>
        <span>Situação</span>
        <span>Vínculos</span>
        <span>Atividade</span>
        <span>Ação</span>
      </div>
      <div className={ADMIN_LIST_ZEBRA_CLASS}>
        {rows.map((row) => {
          const activity = row.last_activity_at ? formatStackedDateTimeBR(row.last_activity_at) : null;
          return (
            <div key={row.case_id} className={ADMIN_LIST_ROW_CLASS}>
              <div className={`hidden h-16 items-center gap-2 px-3 lg:grid ${DESKTOP_GRID}`}>
                <span className="min-w-0">
                  <span className="block truncate font-medium" title={row.display_name || "Sem nome"}>{row.display_name || "Sem nome"}</span>
                  <span className="block truncate text-[11px] text-slate-500">{presence(row)}</span>
                </span>
                <span className="min-w-0 truncate text-slate-300" title={row.display_email || undefined}>{row.display_email || "—"}</span>
                <span className="min-w-0 overflow-hidden"><StatusBadge state={row.state} /></span>
                <span className="text-slate-300">{row.is_owner ? "Proprietário" : row.has_tickets ? "Ingresso" : "—"}</span>
                <time className="block text-[11px] leading-tight text-slate-300" dateTime={row.last_activity_at ?? undefined}>
                  <span className="block">{activity?.line1 ?? "—"}</span>
                  {activity?.line2 ? <span className="block text-slate-400">{activity.line2}</span> : null}
                </time>
                <Link href={accountHealthCaseHref(row.case_id)} className={actionClass}>Abrir</Link>
              </div>
              <article className="space-y-2 px-3 py-3 lg:hidden">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-medium">{row.display_name || "Sem nome"}</h3>
                    <p className="truncate text-xs text-slate-400">{row.display_email || "Sem e-mail"}</p>
                  </div>
                  <StatusBadge state={row.state} />
                </div>
                <p className="text-xs text-slate-400">{row.reason_message}</p>
                <Link href={accountHealthCaseHref(row.case_id)} className={`${actionClass} w-full`}>Abrir caso</Link>
              </article>
            </div>
          );
        })}
      </div>
    </div>
  );
}
