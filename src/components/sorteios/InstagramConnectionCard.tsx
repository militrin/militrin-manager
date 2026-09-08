"use client";

import { useState, useTransition } from "react";
import { AtSign } from "lucide-react";
import { beginInstagramOAuth, disconnectInstagram, type InstagramIntegrationStatus } from "@/app/sorteios/instagram-actions";
import { formatInstagramHandle } from "./types";

export function InstagramConnectionCard({
  initialStatus,
  compact = false,
}: {
  initialStatus: InstagramIntegrationStatus;
  compact?: boolean;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const handle = formatInstagramHandle(status.username);

  function connect() {
    setError(null);
    startTransition(async () => {
      try {
        const { url } = await beginInstagramOAuth();
        window.location.assign(url);
      } catch (value) {
        setError(value instanceof Error ? value.message : "Não foi possível iniciar a conexão com o Instagram.");
      }
    });
  }

  function disconnect() {
    if (!window.confirm("Desconectar esta conta do Instagram? Os sorteios históricos serão preservados.")) return;
    setError(null);
    startTransition(async () => {
      try {
        await disconnectInstagram();
        setStatus({ state: "available", connected: false });
      } catch (value) {
        setError(value instanceof Error ? value.message : "Não foi possível desconectar o Instagram.");
      }
    });
  }

  if (status.state === "database_not_ready" || status.state === "not_configured") {
    return (
      <p className="rounded-xl border border-slate-700 bg-slate-950/50 p-3 text-sm text-slate-300">
        Integração com Instagram ainda não configurada. O sorteio por CSV continua disponível.
      </p>
    );
  }

  return (
    <div className={`rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/5 ${compact ? "p-3" : "p-4"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-semibold text-white">
          <AtSign size={18} />
          {handle ?? "Instagram"}
        </p>
        {status.connected ? (
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs text-emerald-200">Status: conectado</span>
            <button type="button" disabled={pending} onClick={disconnect} className="text-xs text-rose-300 hover:text-rose-200 disabled:opacity-50">
              Desconectar
            </button>
          </div>
        ) : (
          <button type="button" disabled={pending} onClick={connect} className="rounded-xl bg-fuchsia-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            CONECTAR INSTAGRAM
          </button>
        )}
      </div>
      {error ? <p className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">{error}</p> : null}
    </div>
  );
}
