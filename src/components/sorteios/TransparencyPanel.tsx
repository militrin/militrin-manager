"use client";

import type { ArchivedSession, SorteioSession } from "./types";

type TransparencyPanelProps = {
  session: SorteioSession;
  archived: ArchivedSession[];
};

function formatDateTime(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("pt-BR");
}

export function TransparencyPanel({ session, archived }: TransparencyPanelProps) {
  const uniqueUsers = new Set(session.entries.map((e) => e.username.toLowerCase())).size;

  const rows: Array<[string, string]> = [
    ["Identificador do sorteio", session.id],
    ["Total de entradas", String(session.entries.length)],
    ["Total de usuários únicos", String(uniqueUsers)],
    ["Nome do arquivo importado", session.importedFileName ?? "-"],
    ["Data da importação", formatDateTime(session.importedAt)],
    ["Data/hora do sorteio", formatDateTime(session.currentDrawAt)],
  ];

  return (
    <div className="space-y-5">
      <p className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-300">
        Cada comentário importado corresponde a uma entrada independente no sorteio. Comentários repetidos do mesmo
        perfil não são unificados: cada um representa uma chance própria.
      </p>

      <dl className="grid gap-3 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <dt className="text-xs uppercase tracking-[0.14em] text-slate-500">{label}</dt>
            <dd className="mt-1 text-sm font-medium text-slate-100">{value}</dd>
          </div>
        ))}
      </dl>

      {archived.length > 0 ? (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Sorteios anteriores (histórico preservado)</h4>
          <ul className="mt-2 space-y-2">
            {archived
              .slice()
              .reverse()
              .map((s) => {
                const winner = s.entries.find((e) => e.commentId === s.confirmedWinner?.commentId);
                return (
                  <li key={s.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-slate-100">{s.id}</span>
                      <span className="text-xs text-slate-500">{formatDateTime(s.archivedAt)}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">
                      {winner ? `Ganhador: @${winner.username}` : "Sem ganhador confirmado"} · {s.entries.length} chances
                    </p>
                  </li>
                );
              })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
