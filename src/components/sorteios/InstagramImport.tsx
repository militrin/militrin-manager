"use client";

import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { selectGiveawayInstagramMedia, syncGiveawayComments } from "@/app/sorteios/giveaway-sync-actions";
import { InstagramConnectionCard } from "./InstagramConnectionCard";
import { InstagramMediaPicker } from "./InstagramMediaPicker";
import type { InstagramIntegrationStatus } from "@/app/sorteios/instagram-actions";
import type { ParticipationEntry } from "./types";

export function InstagramImport({
  giveawayId,
  locked,
  canChangePost,
  source,
  permalink,
  mediaId,
  initialStatus,
  onImported,
}: {
  giveawayId: string;
  locked: boolean;
  canChangePost: boolean;
  source: "csv" | "instagram";
  permalink: string | null;
  mediaId: string | null;
  initialStatus: InstagramIntegrationStatus;
  onImported: (value: { entries: ParticipationEntry[]; mediaId: string; permalink: string; integrationId: string; syncedAt: string }) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [currentMediaId, setCurrentMediaId] = useState(mediaId);

  function sync() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await syncGiveawayComments(giveawayId);
        setCurrentMediaId(result.mediaId);
        onImported(result);
      } catch (value) {
        setError(value instanceof Error ? value.message : "Não foi possível sincronizar os comentários.");
      }
    });
  }

  return (
    <div className="space-y-3 rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/5 p-4">
      <InstagramConnectionCard initialStatus={initialStatus} compact />
      {permalink ? (
        <a href={permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-slate-300">
          Publicação vinculada <ExternalLink size={13} />
        </a>
      ) : (
        <p className="text-xs text-slate-400">Nenhuma publicação vinculada a este sorteio.</p>
      )}

      {source === "instagram" && !locked && initialStatus.connected ? (
        <div className="space-y-3">
          {canChangePost ? (
            <InstagramMediaPicker
              selectedMediaId={currentMediaId}
              onSelect={(media) => {
                setError(null);
                startTransition(async () => {
                  try {
                    const saved = await selectGiveawayInstagramMedia({ giveawayId, mediaId: media.mediaId });
                    setCurrentMediaId(saved.mediaId);
                  } catch (value) {
                    setError(value instanceof Error ? value.message : "Não foi possível vincular a publicação.");
                  }
                });
              }}
            />
          ) : null}
          <button
            type="button"
            disabled={pending || locked || !currentMediaId}
            onClick={sync}
            className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
          >
            {pending ? "SINCRONIZANDO…" : "SINCRONIZAR COMENTÁRIOS"}
          </button>
        </div>
      ) : null}

      {locked ? <p className="text-xs text-amber-200">Snapshot congelado: sincronização, troca de post e importação CSV estão bloqueadas.</p> : null}
      {error ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">{error}</p> : null}
    </div>
  );
}
