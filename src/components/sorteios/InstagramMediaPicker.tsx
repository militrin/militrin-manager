"use client";

import { useState, useTransition } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { loadInstagramMediaPage } from "@/app/sorteios/giveaway-sync-actions";
import { beginInstagramOAuth } from "@/app/sorteios/instagram-actions";
import type { InstagramMediaCard } from "@/lib/giveaways/media";

function mediaTypeLabel(type: string) {
  const normalized = type.toUpperCase();
  if (normalized === "VIDEO" || normalized === "REELS") return "Vídeo / Reels";
  if (normalized === "CAROUSEL_ALBUM") return "Carrossel";
  if (normalized === "IMAGE") return "Imagem";
  return type || "Publicação";
}

export function InstagramMediaPicker({
  disabled = false,
  selectedMediaId = null,
  onSelect,
}: {
  disabled?: boolean;
  selectedMediaId?: string | null;
  onSelect: (media: InstagramMediaCard) => void;
}) {
  const [items, setItems] = useState<InstagramMediaCard[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [canReconnect, setCanReconnect] = useState(false);
  const [pending, startTransition] = useTransition();

  function load(after?: string | null, replace = false) {
    setError(null);
    setDetail(null);
    setCanReconnect(false);
    startTransition(async () => {
      try {
        const page = await loadInstagramMediaPage(after);
        if (!page.ok) {
          setError(page.message);
          setDetail(page.detail);
          setCanReconnect(page.reconnectRequired || page.canReconnect);
          setLoaded(true);
          if (replace) {
            setItems([]);
            setNextCursor(null);
          }
          return;
        }
        setItems((current) => replace ? page.items : [...current, ...page.items]);
        setNextCursor(page.nextCursor);
        setLoaded(true);
      } catch {
        setError("Não foi possível carregar as publicações do Instagram.");
        setDetail("Não foi possível concluir a operação com o Instagram. Tente novamente.");
        setCanReconnect(false);
        setLoaded(true);
      }
    });
  }

  function reconnect() {
    startTransition(async () => {
      try {
        const { url } = await beginInstagramOAuth();
        window.location.assign(url);
      } catch {
        setError("Não foi possível carregar as publicações do Instagram.");
        setDetail("A conexão com o Instagram expirou. Reconecte a conta.");
        setCanReconnect(true);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || disabled}
          onClick={() => load(null, true)}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-100 disabled:opacity-50"
        >
          <RefreshCw size={15} className={pending ? "animate-spin" : undefined} />
          {loaded ? "ATUALIZAR PUBLICAÇÕES" : "CARREGAR PUBLICAÇÕES"}
        </button>
      </div>

      {pending && !loaded ? <p className="text-sm text-slate-400">Carregando publicações da conta conectada…</p> : null}
      {error ? (
        <div className="space-y-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          <p>{error}</p>
          {detail ? <p className="text-rose-100/80">{detail}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending || disabled}
              onClick={() => load(null, true)}
              className="rounded-lg border border-rose-300/40 px-3 py-1.5 text-xs font-semibold text-rose-50 disabled:opacity-50"
            >
              Tentar novamente
            </button>
            {canReconnect ? (
              <button
                type="button"
                disabled={pending || disabled}
                onClick={reconnect}
                className="rounded-lg bg-fuchsia-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              >
                Reconectar Instagram
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {loaded && !pending && !error && items.length === 0 ? (
        <p className="rounded-xl border border-slate-700 bg-slate-950/50 p-3 text-sm text-slate-300">Nenhuma publicação disponível foi encontrada.</p>
      ) : null}

      {items.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const selected = selectedMediaId === item.mediaId;
            return (
              <li key={item.mediaId} className={`overflow-hidden rounded-2xl border ${selected ? "border-emerald-400" : "border-slate-800"} bg-slate-950/60`}>
                {item.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.thumbnailUrl} alt="" className="h-40 w-full object-cover" />
                ) : (
                  <div className="flex h-40 items-center justify-center bg-slate-900 text-xs text-slate-500">Sem miniatura</div>
                )}
                <div className="space-y-2 p-3">
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-500">{mediaTypeLabel(item.mediaType)}</p>
                  <p className="text-xs text-slate-400">{item.timestamp ? new Date(item.timestamp).toLocaleString("pt-BR") : "Data indisponível"}</p>
                  <p className="line-clamp-2 text-sm text-slate-200">{item.caption || "Sem legenda"}</p>
                  <div className="flex flex-wrap gap-2">
                    {item.permalink ? (
                      <a href={item.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-slate-300">
                        VER NO INSTAGRAM <ExternalLink size={12} />
                      </a>
                    ) : null}
                    <button
                      type="button"
                      disabled={disabled || pending}
                      onClick={() => onSelect(item)}
                      className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50"
                    >
                      {selected ? "SELECIONADA" : "SELECIONAR"}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {nextCursor ? (
        <button type="button" disabled={pending || disabled} onClick={() => load(nextCursor)} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 disabled:opacity-50">
          Carregar mais
        </button>
      ) : null}
    </div>
  );
}
