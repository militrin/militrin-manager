"use client";

import { useState } from "react";
import Link from "next/link";
import {
  INVITE_CENTER_STATUS_LABEL,
  INVITE_CENTER_STATUS_TONE,
  canResendInviteCenter,
  inviteCenterAdminActionReason,
  inviteCenterFirstAccessLabel,
} from "@/lib/invites/invite-center-status";
import { sharedEmailBadgeLabel, sharedEmailResolvedAccountLabel } from "@/lib/account/shared-email-ownership";
import { formatDateTimeBR } from "@/lib/utils/date";
import { ADMIN_LIST_HEADER_CLASS, ADMIN_LIST_ROW_CLASS, ADMIN_LIST_ZEBRA_CLASS, adminTableRowProps } from "@/components/admin";
import type { InviteCenterListRow } from "@/lib/invites/invite-center-types";

const actionClass = "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg border border-slate-700 px-2.5 text-xs";

function StatusBadge({ status }: { status: InviteCenterListRow["status"] }) {
  const tone = INVITE_CENTER_STATUS_TONE[status];
  const className = {
    default: "border-slate-600 bg-slate-800/70 text-slate-200",
    success: "border-emerald-500/40 bg-emerald-500/15 text-emerald-200",
    warning: "border-amber-500/40 bg-amber-500/15 text-amber-200",
    danger: "border-rose-500/40 bg-rose-500/15 text-rose-200",
    info: "border-cyan-500/40 bg-cyan-500/15 text-cyan-200",
  }[tone];
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium ${className}`}>{INVITE_CENTER_STATUS_LABEL[status]}</span>;
}

export function InviteCenterList({
  rows,
  canResend,
}: {
  rows: InviteCenterListRow[];
  canResend: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!rows.length) return null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 text-sm">
      <div className={`hidden grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1fr)_90px_110px_110px_130px_140px_80px] gap-2 bg-slate-900 px-3 text-slate-400 lg:grid ${ADMIN_LIST_HEADER_CLASS}`}>
        <span>Pessoa / Conta principal</span>
        <span>E-mail</span>
        <span>Evento</span>
        <span>Ingressos</span>
        <span>Enviado em</span>
        <span>Validade</span>
        <span>Status</span>
        <span>Primeiro acesso</span>
        <span>Ações</span>
      </div>
      <div className={`${ADMIN_LIST_ZEBRA_CLASS} divide-y divide-slate-800`}>
        {rows.map((row) => {
          const isOpen = expanded === row.row_key;
          const firstAccess = inviteCenterFirstAccessLabel(row.status, row.cadastral_incomplete);
          const accountLabel = row.person_count > 1 ? sharedEmailResolvedAccountLabel(row.principal_name) : null;
          return (
            <div key={row.row_key} className={ADMIN_LIST_ROW_CLASS} {...adminTableRowProps({ selected: isOpen })}>
              <div className="flex items-center gap-2 px-3 py-2.5 lg:grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1fr)_90px_110px_110px_130px_140px_80px] lg:items-center lg:gap-2 lg:py-3">
                <button type="button" onClick={() => setExpanded(isOpen ? null : row.row_key)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate font-medium hover:text-emerald-300">{row.principal_name || "Sem nome"}</span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500 lg:hidden">{row.email_masked}</span>
                  {row.person_count > 1 ? (
                    <span className="mt-1 flex flex-wrap gap-1 lg:hidden">
                      <span className="w-fit rounded-full border border-violet-400/40 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-100">{sharedEmailBadgeLabel(row.person_count)}</span>
                      {accountLabel ? <span className="w-fit rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-100">{accountLabel}</span> : null}
                    </span>
                  ) : null}
                  <span className="mt-1 block lg:hidden"><StatusBadge status={row.status} /></span>
                </button>
                <span className="hidden min-w-0 lg:flex lg:flex-col">
                  <span className="truncate text-slate-300">{row.email_masked}</span>
                  {row.person_count > 1 ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      <span className="w-fit rounded-full border border-violet-400/40 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-100">{sharedEmailBadgeLabel(row.person_count)}</span>
                      {accountLabel ? <span className="w-fit rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-100">{accountLabel}</span> : null}
                    </span>
                  ) : null}
                </span>
                <span className="hidden truncate lg:inline">{row.event_name || "—"}</span>
                <span className="hidden lg:inline">{row.ticket_count} {row.ticket_count === 1 ? "ingresso" : "ingressos"}</span>
                <span className="hidden lg:inline">{row.sent_at || row.invite_created_at ? formatDateTimeBR(row.sent_at || row.invite_created_at) : "—"}</span>
                <span className="hidden lg:inline">{row.expires_at ? `até ${formatDateTimeBR(row.expires_at)}` : "—"}</span>
                <span className="hidden lg:inline"><StatusBadge status={row.status} /></span>
                <span className="hidden text-xs text-slate-400 lg:inline">{firstAccess}</span>
                <div className="hidden shrink-0 lg:flex"><Link href={`/convites/${row.row_key}`} className={actionClass}>Abrir</Link></div>
                <Link href={`/convites/${row.row_key}`} className={`${actionClass} lg:hidden`}>Abrir</Link>
              </div>
              <div className="grid gap-1 px-3 pb-3 text-xs text-slate-400 lg:hidden">
                <p>{row.event_name || "Sem evento"} · {row.ticket_count} {row.ticket_count === 1 ? "ingresso" : "ingressos"}</p>
                <p>Enviado: {row.sent_at || row.invite_created_at ? formatDateTimeBR(row.sent_at || row.invite_created_at) : "—"}</p>
                <p>Validade: {row.expires_at ? formatDateTimeBR(row.expires_at) : "—"}</p>
              </div>
              {isOpen ? (
                <div className="border-t border-slate-800 bg-slate-900/60 p-4">
                  {row.status === "admin_action" ? (
                    <p className="mb-3 text-sm text-rose-200">{inviteCenterAdminActionReason(Boolean(row.mixed_intended_owners))}</p>
                  ) : null}
                  {row.person_count > 1 && row.people?.length ? (
                    <ul className="mb-3 space-y-1 text-sm">
                      {row.people.map((person) => (
                        <li key={person.contact_id} className="text-slate-200">
                          {person.full_name} — {person.is_principal ? "principal" : "titular"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="text-sm text-slate-300">{firstAccess}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href={`/convites/${row.row_key}`} className={actionClass}>Abrir ficha</Link>
                    {row.principal_contact_id ? <Link href={`/cadastros/${row.principal_contact_id}`} className={actionClass}>Abrir cadastro</Link> : null}
                    {row.status === "admin_action" && row.principal_contact_id ? (
                      <Link href={`/cadastros/${row.principal_contact_id}/conta-compartilhada`} className={actionClass}>Gerenciar</Link>
                    ) : null}
                    {canResend && canResendInviteCenter(row.status) ? (
                      <Link href={`/convites/${row.row_key}#reenviar`} className={actionClass}>Reenviar</Link>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
