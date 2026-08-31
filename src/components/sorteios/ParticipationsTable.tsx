"use client";

import { useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import type { ParticipationEntry, SorteioSession } from "./types";

type ParticipationsTableProps = {
  session: SorteioSession;
};

function statusLabel(entry: ParticipationEntry, session: SorteioSession) {
  if (session.confirmedWinner?.commentId === entry.commentId) return { label: "Ganhador confirmado", tone: "text-emerald-300 border-emerald-500/40 bg-emerald-500/10" };
  if (session.currentWinnerCommentId === entry.commentId && session.status === "awaiting_validation") return { label: "Selecionado (em validação)", tone: "text-amber-200 border-amber-500/40 bg-amber-500/10" };
  if (entry.status === "disqualified") return { label: "Desclassificado", tone: "text-rose-200 border-rose-500/40 bg-rose-500/10" };
  return { label: "Ativo", tone: "text-slate-300 border-slate-700 bg-slate-900/60" };
}

export function ParticipationsTable({ session }: ParticipationsTableProps) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase().replace(/^@/, "");
    if (!term) return session.entries;
    return session.entries.filter((e) => e.username.toLowerCase().includes(term));
  }, [search, session.entries]);

  const exactUserCount = useMemo(() => {
    const term = search.trim().toLowerCase().replace(/^@/, "");
    if (!term) return null;
    return session.entries.filter((e) => e.username.toLowerCase() === term).length;
  }, [search, session.entries]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2">
          <Search size={16} className="text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por username (ex: saabrina_leticia)"
            className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
          />
        </div>
        {exactUserCount !== null ? (
          <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-200">
            Total de chances deste perfil: {exactUserCount}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-800">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-slate-900/80 text-xs uppercase tracking-[0.08em] text-slate-400">
            <tr>
              <th className="px-3 py-2.5">#</th>
              <th className="px-3 py-2.5">Usuário</th>
              <th className="px-3 py-2.5">Comentário</th>
              <th className="px-3 py-2.5">Marcações</th>
              <th className="px-3 py-2.5">ID</th>
              <th className="px-3 py-2.5">Link</th>
              <th className="px-3 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80">
            {filtered.map((entry) => {
              const status = statusLabel(entry, session);
              return (
                <tr key={entry.commentId} className="text-slate-200">
                  <td className="px-3 py-2.5 text-slate-400">{entry.entryNumber}</td>
                  <td className="px-3 py-2.5 font-medium text-white">@{entry.username}</td>
                  <td className="max-w-[320px] truncate px-3 py-2.5 text-slate-300" title={entry.comment}>
                    {entry.comment || "-"}
                  </td>
                  <td className="px-3 py-2.5 text-slate-400">
                    {entry.mentionsCount !== null ? entry.mentionsCount : "Verificação manual necessária"}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-slate-500">{entry.commentId}</td>
                  <td className="px-3 py-2.5">
                    {entry.commentUrl ? (
                      <a
                        href={entry.commentUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200"
                      >
                        Ver <ExternalLink size={12} />
                      </a>
                    ) : (
                      <span className="text-slate-600">-</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${status.tone}`}>{status.label}</span>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-500">
                  Nenhuma participação encontrada.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
