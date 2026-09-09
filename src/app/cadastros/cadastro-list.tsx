"use client";

import Link from "next/link";
import { useState } from "react";
import { CopyableId } from "@/components/CopyableId";
import { ADMIN_LIST_HEADER_CLASS, ADMIN_LIST_ROW_CLASS, ADMIN_LIST_ZEBRA_CLASS, adminTableRowProps } from "@/components/admin";
import { sharedEmailBadgeLabel, sharedEmailResolvedAccountLabel } from "@/lib/account/shared-email-ownership";

type Row = {
  id: string;
  name: string;
  cpf: string;
  birthDate: string;
  gender: string;
  phone: string;
  email: string;
  city: string;
  publicPin: string | null;
  origin: string;
  ticketCount: number;
  eventCount: number;
  sharedEmailCount: number;
  sharedEmailStatus: "pending" | "resolved" | null;
  sharedEmailPrincipalName: string | null;
};

function SharedEmailBadges({ row }: { row: Row }) {
  if (row.sharedEmailCount <= 1) return null;
  const accountLabel = row.sharedEmailStatus === "resolved" ? sharedEmailResolvedAccountLabel(row.sharedEmailPrincipalName) : null;
  return (
    <span className="flex flex-wrap gap-1">
      <Link href={`/cadastros/${row.id}/conta-compartilhada`} onClick={(event) => event.stopPropagation()} className="w-fit rounded-full border border-violet-400/40 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-100 hover:border-violet-300">
        {sharedEmailBadgeLabel(row.sharedEmailCount)}
      </Link>
      {accountLabel ? (
        <Link href={`/cadastros/${row.id}/conta-compartilhada`} onClick={(event) => event.stopPropagation()} className="w-fit rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-100 hover:border-emerald-300">
          {accountLabel}
        </Link>
      ) : (
        <Link href={`/cadastros/${row.id}/conta-compartilhada`} onClick={(event) => event.stopPropagation()} className="w-fit rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-100 hover:border-amber-300">
          Pendente
        </Link>
      )}
    </span>
  );
}

function maskCpf(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 ? `***.***.***-${digits.slice(-2)}` : "Não informado";
}

const actionClass = "inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-lg border border-slate-700 px-2.5 text-xs";

export function CadastroList({ rows, canEdit, canIssueTicket }: { rows: Row[]; canEdit: boolean; canIssueTicket: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!rows.length) return <div className="rounded-2xl border border-dashed border-slate-700 py-12 text-center text-slate-400">Nenhum cadastro encontrado com estes filtros.</div>;
  return <div className="overflow-hidden rounded-2xl border border-slate-800 text-sm">
    <div className={`hidden grid-cols-[minmax(0,1.8fr)_130px_minmax(0,1.4fr)_90px_90px_130px] gap-2 bg-slate-900 px-3 text-slate-400 lg:grid ${ADMIN_LIST_HEADER_CLASS}`}><span>Nome</span><span>CPF</span><span>Contato</span><span>Ingressos</span><span>Eventos</span><span>Ações</span></div>
    <div className={`${ADMIN_LIST_ZEBRA_CLASS} divide-y divide-slate-800`}>{rows.map((row) => {
      const isOpen = expanded === row.id;
      const secondaryLine = row.email || row.phone || (row.cpf.replace(/\D/g, "").length === 11 ? maskCpf(row.cpf) : null);
      return <div key={row.id} className={ADMIN_LIST_ROW_CLASS} {...adminTableRowProps({ selected: isOpen })}>
        <div className="flex items-center gap-2 px-3 py-2.5 lg:grid lg:grid-cols-[minmax(0,1.8fr)_130px_minmax(0,1.4fr)_90px_90px_130px] lg:items-center lg:gap-2 lg:py-3">
          <button type="button" onClick={() => setExpanded(isOpen ? null : row.id)} className="min-w-0 flex-1 text-left">
            <span className="block truncate font-medium hover:text-emerald-300">{row.name}</span>
            {secondaryLine ? <span className="mt-0.5 block truncate text-xs text-slate-500 lg:hidden">{secondaryLine}</span> : null}
            <span className="mt-1 block lg:hidden"><SharedEmailBadges row={row} /></span>
          </button>
          <span className="hidden lg:inline">{maskCpf(row.cpf)}</span>
          <span className="hidden min-w-0 lg:flex lg:flex-col">
            <span className="truncate text-slate-300" title={row.email || row.phone}>{row.email || row.phone || "Não informado"}</span>
            <SharedEmailBadges row={row} />
          </span>
          <span className="hidden lg:inline">{row.ticketCount}</span><span className="hidden lg:inline">{row.eventCount}</span>
          <div className="hidden shrink-0 gap-1.5 lg:flex"><Link href={`/cadastros/${row.id}`} className={actionClass}>Abrir ficha</Link></div>
          <Link href={`/cadastros/${row.id}`} className={`${actionClass} lg:hidden`}>Abrir ficha</Link>
        </div>
        {isOpen ? <div className="border-t border-slate-800 bg-slate-900/60 p-4">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Nome completo",row.name],["CPF",maskCpf(row.cpf)],["Nascimento",row.birthDate || "Não informado"],["Gênero",row.gender || "Não informado"],["Telefone",row.phone || "Não informado"],["E-mail",row.email || "Não informado"],["Cidade",row.city || "Não informada"],["Origem",row.origin]].map(([label,value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-0.5 break-words text-slate-200">{value}</dd></div>)}</dl>
          <div className="mt-3"><CopyableId label="PIN do cadastro" value={row.publicPin}/></div>
          <div className="mt-4 flex flex-wrap gap-2"><Link href={`/cadastros/${row.id}`} className={actionClass}>Ver ficha e ingressos</Link>{row.sharedEmailCount > 1 ? <Link href={`/cadastros/${row.id}/conta-compartilhada`} className={actionClass}>Gerenciar conta e ingressos</Link> : null}{canEdit ? <Link href={`/cadastros/${row.id}/editar`} className={actionClass}>Editar cadastro</Link> : null}{canIssueTicket ? <Link href={row.publicPin ? `/ingressos/emitir?pin=${row.publicPin}` : "/ingressos/emitir"} className={actionClass}>Emitir ingresso</Link> : null}</div>
        </div> : null}
      </div>;
    })}</div>
  </div>;
}
