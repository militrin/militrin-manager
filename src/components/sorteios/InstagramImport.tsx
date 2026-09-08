"use client";

import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { selectGiveawayInstagramMedia, syncGiveawayComments } from "@/app/sorteios/giveaway-sync-actions";
import { canStartGiveaway, giveawayRequiresPostChangeConfirmation } from "@/lib/giveaways/status";
import type { InstagramMediaCard } from "@/lib/giveaways/media";
import { InstagramConnectionCard } from "./InstagramConnectionCard";
import { InstagramMediaPicker } from "./InstagramMediaPicker";
import { StrongConfirmModal } from "./StrongConfirmModal";
import type { InstagramIntegrationStatus } from "@/app/sorteios/instagram-actions";
import type { ParticipationEntry } from "./types";

export function InstagramImport({
  giveawayId,
  locked,
  canChangePost,
  source,
  permalink,
  mediaId,
  commentsCount,
  uniqueParticipants,
  status,
  snapshotFrozenAt,
  initialStatus,
  onImported,
  onPostChanged,
  onStartDraw,
}: {
  giveawayId: string;
  locked: boolean;
  canChangePost: boolean;
  source: "csv" | "instagram";
  permalink: string | null;
  mediaId: string | null;
  commentsCount: number;
  uniqueParticipants: number;
  status: string;
  snapshotFrozenAt: string | null;
  initialStatus: InstagramIntegrationStatus;
  onImported: (value: { entries: ParticipationEntry[]; mediaId: string; permalink: string; integrationId: string; syncedAt: string; status: "preparing" | "ready"; pagesFetched: number }) => void;
  onPostChanged: (value: InstagramMediaCard & { commentsCleared: number }) => void;
  onStartDraw: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [currentMediaId, setCurrentMediaId] = useState(mediaId);
  const [showPicker, setShowPicker] = useState(!mediaId && canChangePost && source === "instagram");
  const [pendingMedia, setPendingMedia] = useState<InstagramMediaCard | null>(null);

  const canStart = canStartGiveaway(status, snapshotFrozenAt, commentsCount);
  const startBlockedReason = commentsCount === 0 ? "Sincronize pelo menos um comentário antes de iniciar." : null;

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

  function applyMedia(media: InstagramMediaCard, confirmReplaceComments: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        const saved = await selectGiveawayInstagramMedia({ giveawayId, mediaId: media.mediaId, confirmReplaceComments });
        setCurrentMediaId(saved.mediaId);
        setShowPicker(false);
        setPendingMedia(null);
        onPostChanged(saved);
      } catch (value) {
        setError(value instanceof Error ? value.message : "Não foi possível vincular a publicação.");
      }
    });
  }

  function requestMediaChange(media: InstagramMediaCard) {
    if (giveawayRequiresPostChangeConfirmation(commentsCount)) {
      setPendingMedia(media);
      return;
    }
    applyMedia(media, false);
  }

  return (
    <div className="space-y-3 rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/5 p-4">
      <InstagramConnectionCard initialStatus={initialStatus} compact />
      {source === "csv" ? (
        permalink ? (
          <a href={permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-slate-300">
            Publicação histórica (CSV legado, sem media_id) <ExternalLink size={13} />
          </a>
        ) : (
          <p className="text-xs text-slate-400">Sorteio CSV legado. Nenhuma publicação do Instagram está vinculada como media_id.</p>
        )
      ) : permalink ? (
        <a href={permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-slate-300">
          Publicação vinculada <ExternalLink size={13} />
        </a>
      ) : (
        <p className="text-xs text-slate-400">Nenhuma publicação vinculada a este sorteio.</p>
      )}

      {source === "instagram" ? (
        <div className="grid gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-300 sm:grid-cols-2">
          <p><span className="text-slate-500">Publicação</span><br />{permalink ?? "Não vinculada"}</p>
          <p><span className="text-slate-500">Status da sincronização</span><br />{commentsCount > 0 ? `${commentsCount} comentários sincronizados.` : "Nenhum comentário encontrado nesta publicação."}</p>
          <p><span className="text-slate-500">Comentários</span><br />{commentsCount}</p>
          <p><span className="text-slate-500">Participantes</span><br />{uniqueParticipants}</p>
          <p><span className="text-slate-500">Chances</span><br />{commentsCount}</p>
        </div>
      ) : null}

      {source === "instagram" && !locked && initialStatus.connected ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending || locked || !currentMediaId}
              onClick={sync}
              className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              {pending ? "ATUALIZANDO…" : "ATUALIZAR COMENTÁRIOS"}
            </button>
            {canChangePost ? (
              <button
                type="button"
                disabled={pending || locked}
                onClick={() => setShowPicker((current) => !current)}
                className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-100 disabled:opacity-50"
              >
                TROCAR PUBLICAÇÃO
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending || locked || !canStart}
              title={startBlockedReason ?? undefined}
              onClick={onStartDraw}
              className="rounded-xl border border-emerald-400/40 px-4 py-2 text-sm font-semibold text-emerald-200 disabled:opacity-40"
            >
              INICIAR SORTEIO
            </button>
          </div>
          {!canStart && startBlockedReason ? <p className="text-xs text-amber-200">{startBlockedReason}</p> : null}
          {showPicker && canChangePost ? (
            <InstagramMediaPicker
              selectedMediaId={currentMediaId}
              onSelect={requestMediaChange}
            />
          ) : null}
        </div>
      ) : null}

      {locked ? <p className="text-xs text-amber-200">Snapshot congelado: sincronização, troca de post e importação CSV estão bloqueadas.</p> : null}
      {error ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">{error}</p> : null}

      <StrongConfirmModal
        open={pendingMedia !== null}
        title="Trocar publicação"
        description="Trocar a publicação removerá os comentários sincronizados deste rascunho. Deseja continuar?"
        confirmLabel="TROCAR E LIMPAR COMENTÁRIOS"
        tone="rose"
        pending={pending}
        onCancel={() => setPendingMedia(null)}
        onConfirm={() => {
          if (pendingMedia) applyMedia(pendingMedia, true);
        }}
      />
    </div>
  );
}
