"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createGiveaway } from "@/app/sorteios/giveaway-actions";
import { InstagramConnectionCard } from "./InstagramConnectionCard";
import { InstagramMediaPicker } from "./InstagramMediaPicker";
import type { InstagramIntegrationStatus } from "@/app/sorteios/instagram-actions";
import type { InstagramMediaCard } from "@/lib/giveaways/media";

export function GiveawayCreateForm({ instagramStatus }: { instagramStatus: InstagramIntegrationStatus }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<"instagram" | "csv">("instagram");
  const [selected, setSelected] = useState<InstagramMediaCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    if (source === "instagram" && !selected) {
      setError("Selecione explicitamente uma publicação. Nenhuma vem pré-selecionada.");
      return;
    }
    if (source === "instagram" && selected && !selected.permalink) {
      setError("A publicação escolhida não tem permalink oficial da Meta.");
      return;
    }
    startTransition(async () => {
      try {
        const created = await createGiveaway({
          name,
          description: description || null,
          source,
          instagramMedia: source === "instagram" && selected ? {
            mediaId: selected.mediaId,
            mediaType: selected.mediaType,
            permalink: selected.permalink,
            caption: selected.caption,
            thumbnailUrl: selected.thumbnailUrl,
            publishedAt: selected.timestamp,
          } : null,
        });
        router.push(`/sorteios/${created.id}`);
      } catch (value) {
        setError(value instanceof Error ? value.message : "Não foi possível criar o sorteio.");
      }
    });
  }

  return (
    <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-400">Etapa 1 — Dados básicos</h2>
        <label className="block text-sm text-slate-300">
          Nome do sorteio
          <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-white" maxLength={120} />
        </label>
        <label className="block text-sm text-slate-300">
          Descrição (opcional)
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-white" maxLength={2000} rows={3} />
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm text-slate-300">Fonte</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="source" checked={source === "instagram"} onChange={() => { setSource("instagram"); setSelected(null); }} />
            INSTAGRAM
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="source" checked={source === "csv"} onChange={() => { setSource("csv"); setSelected(null); }} />
            CSV
          </label>
        </fieldset>
      </section>

      {source === "instagram" ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-400">Publicação do Instagram</h2>
          <InstagramConnectionCard initialStatus={instagramStatus} compact />
          {instagramStatus.connected ? (
            <>
              <p className="text-xs text-slate-400">Nenhuma publicação vem selecionada por padrão. Escolha explicitamente o post deste sorteio.</p>
              <InstagramMediaPicker selectedMediaId={selected?.mediaId ?? null} onSelect={setSelected} />
            </>
          ) : (
            <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">Conecte o Instagram antes de escolher a publicação.</p>
          )}
        </section>
      ) : (
        <p className="rounded-xl border border-slate-700 bg-slate-950/40 p-3 text-sm text-slate-300">
          Depois de criar o rascunho, você importa o CSV na tela do sorteio.
        </p>
      )}

      {error ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}

      <button
        type="button"
        disabled={pending || !name.trim() || (source === "instagram" && !selected)}
        onClick={submit}
        className="rounded-xl bg-emerald-400 px-5 py-2.5 text-sm font-semibold text-slate-950 disabled:opacity-40"
      >
        {pending ? "CRIANDO…" : "CRIAR RASCUNHO"}
      </button>
    </div>
  );
}
