"use client";

import { useState, useTransition } from "react";
import { AtSign, ExternalLink, RefreshCw } from "lucide-react";
import { beginInstagramOAuth, disconnectInstagram, loadInstagramMedia, syncInstagramComments } from "@/app/sorteios/actions";
import type { ParticipationEntry } from "./types";
import type { InstagramIntegrationStatus } from "@/app/sorteios/actions";

type Media = { id: string; caption: string; permalink: string; timestamp: string; thumbnailUrl: string; mediaType: string };

export function InstagramImport({ locked, initialStatus, onImported }: { locked: boolean; initialStatus: InstagramIntegrationStatus; onImported: (value: { entries: ParticipationEntry[]; mediaId: string; permalink: string; integrationId: string; syncedAt: string }) => void }) {
  const [status, setStatus] = useState<InstagramIntegrationStatus>(initialStatus);
  const [media, setMedia] = useState<Media[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function connect() {
    setError(null);
    startTransition(async () => {
      try { const { url } = await beginInstagramOAuth(); window.location.assign(url); }
      catch (value) { setError(value instanceof Error ? value.message : "Falha ao iniciar OAuth."); }
    });
  }

  function fetchMedia() {
    setError(null);
    startTransition(async () => {
      try { const values = await loadInstagramMedia(); setMedia(values); if (values[0]) setSelected(values[0].id); }
      catch (value) { setError(value instanceof Error ? value.message : "Falha ao carregar publicacoes."); }
    });
  }

  function sync() {
    const item = media.find((value) => value.id === selected);
    if (!item) return;
    setError(null);
    startTransition(async () => {
      try { const result = await syncInstagramComments(item.id); onImported({ entries: result.entries, mediaId: result.mediaId, permalink: result.permalink, integrationId: result.integrationId, syncedAt: result.syncedAt }); }
      catch (value) { setError(value instanceof Error ? value.message : "Falha ao sincronizar comentarios."); }
    });
  }

  function disconnect() {
    if (!window.confirm("Desconectar esta conta do Instagram? Os sorteios historicos serao preservados.")) return;
    setError(null);
    startTransition(async () => {
      try { await disconnectInstagram(); setStatus({ state: "available", connected: false }); setMedia([]); setSelected(""); }
      catch (value) { setError(value instanceof Error ? value.message : "Falha ao desconectar o Instagram."); }
    });
  }

  return (
    <div className="rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-semibold text-white"><AtSign size={18} /> Instagram oficial (Meta)</p>
          <p className="mt-1 text-xs text-slate-400">O autor vem do campo oficial da API; @menções são extraídas somente do texto.</p>
        </div>
        {status?.connected ? <div className="flex items-center gap-2"><span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs text-emerald-200">@{status.username} conectado</span><button type="button" disabled={pending} onClick={disconnect} className="text-xs text-rose-300 hover:text-rose-200 disabled:opacity-50">Desconectar</button></div> : null}
      </div>
      {status.state === "database_not_ready" ? (
        <p className="mt-4 rounded-xl border border-slate-700 bg-slate-950/50 p-3 text-sm text-slate-300">Integração com Instagram ainda não configurada. O sorteio por CSV continua disponível.</p>
      ) : status.state === "not_configured" ? (
        <p className="mt-4 rounded-xl border border-slate-700 bg-slate-950/50 p-3 text-sm text-slate-300">Credenciais da integração Instagram ainda não configuradas. O sorteio por CSV continua disponível.</p>
      ) : !status.connected ? (
        <button type="button" disabled={pending} onClick={connect} className="mt-4 rounded-xl bg-fuchsia-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">CONECTAR INSTAGRAM</button>
      ) : (
        <div className="mt-4 space-y-3">
          <button type="button" disabled={pending || locked} onClick={fetchMedia} className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-100 disabled:opacity-50"><RefreshCw size={15} /> CARREGAR PUBLICAÇÕES</button>
          {media.length ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <select value={selected} onChange={(event) => setSelected(event.target.value)} disabled={locked} className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                {media.map((item) => <option key={item.id} value={item.id}>{new Date(item.timestamp).toLocaleDateString("pt-BR")} — {item.caption.slice(0, 90) || item.mediaType}</option>)}
              </select>
              <button type="button" disabled={pending || locked || !selected} onClick={sync} className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{pending ? "SINCRONIZANDO…" : "SINCRONIZAR TODOS"}</button>
              {media.find((item) => item.id === selected)?.permalink ? <a href={media.find((item) => item.id === selected)?.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-1 text-xs text-slate-300">Abrir <ExternalLink size={13} /></a> : null}
            </div>
          ) : null}
        </div>
      )}
      {locked ? <p className="mt-3 text-xs text-amber-200">Snapshot congelado: a sincronização está bloqueada após o início do sorteio.</p> : null}
      {error ? <p className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">{error}</p> : null}
    </div>
  );
}
