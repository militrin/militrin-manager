"use client";

import Link from "next/link";
import { useState } from "react";
import { CopyableId } from "@/components/CopyableId";

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
};

function maskCpf(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 ? `***.***.***-${digits.slice(-2)}` : "Não informado";
}

const actionClass = "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg border border-slate-700 px-2.5 text-xs lg:h-9 lg:px-3";

export function CadastroList({ rows, canEdit, canIssueTicket }: { rows: Row[]; canEdit: boolean; canIssueTicket: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!rows.length) return <div className="rounded-2xl border border-dashed border-slate-700 py-12 text-center text-slate-400">Nenhum cadastro encontrado com estes filtros.</div>;
  return <div className="overflow-hidden rounded-2xl border border-slate-800 text-sm">
    <div className="hidden grid-cols-[minmax(0,1.8fr)_130px_minmax(0,1.4fr)_90px_90px_130px] gap-2 bg-slate-900 px-3 py-3 text-slate-400 lg:grid"><span>Nome</span><span>CPF</span><span>Contato</span><span>Ingressos</span><span>Eventos</span><span>Ações</span></div>
    <div className="divide-y divide-slate-800">{rows.map((row) => {
      const isOpen = expanded === row.id;
      const secondaryLine = row.email || row.phone || (row.cpf.replace(/\D/g, "").length === 11 ? maskCpf(row.cpf) : null);
      return <div key={row.id} className="bg-slate-950/40">
        <div className="flex items-center gap-2 px-3 py-2.5 lg:grid lg:grid-cols-[minmax(0,1.8fr)_130px_minmax(0,1.4fr)_90px_90px_130px] lg:items-center lg:gap-2 lg:py-3">
          <button type="button" onClick={() => setExpanded(isOpen ? null : row.id)} className="min-w-0 flex-1 text-left">
            <span className="block truncate font-medium hover:text-emerald-300">{row.name}</span>
            {secondaryLine ? <span className="mt-0.5 block truncate text-xs text-slate-500 lg:hidden">{secondaryLine}</span> : null}
          </button>
          <span className="hidden lg:inline">{maskCpf(row.cpf)}</span>
          <span className="hidden truncate text-slate-300 lg:inline" title={row.email || row.phone}>{row.email || row.phone || "Não informado"}</span>
          <span className="hidden lg:inline">{row.ticketCount}</span><span className="hidden lg:inline">{row.eventCount}</span>
          <div className="hidden shrink-0 gap-1.5 lg:flex"><Link href={`/cadastros/${row.id}`} className={actionClass}>Abrir ficha</Link></div>
          <Link href={`/cadastros/${row.id}`} className={`${actionClass} lg:hidden`}>Abrir ficha</Link>
        </div>
        {isOpen ? <div className="border-t border-slate-800 bg-slate-900/60 p-4">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Nome completo",row.name],["CPF",maskCpf(row.cpf)],["Nascimento",row.birthDate || "Não informado"],["Gênero",row.gender || "Não informado"],["Telefone",row.phone || "Não informado"],["E-mail",row.email || "Não informado"],["Cidade",row.city || "Não informada"],["Origem",row.origin]].map(([label,value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-0.5 break-words text-slate-200">{value}</dd></div>)}</dl>
          <div className="mt-3"><CopyableId label="PIN do cadastro" value={row.publicPin}/></div>
          <div className="mt-4 flex flex-wrap gap-2"><Link href={`/cadastros/${row.id}`} className={actionClass}>Ver ficha e ingressos</Link>{canEdit ? <Link href={`/cadastros/${row.id}/editar`} className={actionClass}>Editar cadastro</Link> : null}{canIssueTicket ? <Link href={row.publicPin ? `/ingressos/emitir?pin=${row.publicPin}` : "/ingressos/emitir"} className={actionClass}>Emitir ingresso</Link> : null}</div>
        </div> : null}
      </div>;
    })}</div>
  </div>;
}
