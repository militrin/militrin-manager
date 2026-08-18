"use client";

import { useState, useTransition } from "react";
import {
  addStoreItemImageAction,
  removeStoreItemImageAction,
  reorderStoreItemImagesAction,
  setStoreItemPrimaryImageAction,
} from "./actions";
import { StoreImageUpload } from "./store-image-upload";

type GalleryImage = { id: string; url: string; isPrimary: boolean };

export function StoreItemImageGallery({ storeItemId, images, canManage }: { storeItemId: string; images: GalleryImage[]; canManage: boolean }) {
  const [pending, startTransition] = useTransition();
  const [busyImageId, setBusyImageId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function run(imageId: string | null, action: () => Promise<{ success: boolean; message: string }>) {
    setBusyImageId(imageId);
    startTransition(async () => {
      const result = await action();
      setMessage(result.success ? null : result.message);
      setBusyImageId(null);
    });
  }

  function moveImage(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= images.length) return;
    const reordered = images.map((image) => image.id);
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    run(images[index].id, () => reorderStoreItemImagesAction(storeItemId, reordered));
  }

  if (!canManage) {
    return images.length > 0 ? (
      <div className="mt-3 flex flex-wrap gap-2">
        {images.map((image) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={image.id} src={image.url} alt="" className="h-14 w-14 rounded-lg border border-slate-800 object-cover" />
        ))}
      </div>
    ) : null;
  }

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Fotos ({images.length})</p>
      {images.length === 0 ? (
        <p className="text-xs text-slate-500">Nenhuma foto cadastrada ainda.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {images.map((image, index) => (
            <div key={image.id} className="relative w-20 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt="" className="h-16 w-full rounded object-cover" />
              {image.isPrimary ? (
                <span className="absolute left-1 top-1 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-950">Capa</span>
              ) : null}
              <div className="mt-1 flex items-center justify-between gap-0.5">
                <button
                  type="button"
                  onClick={() => moveImage(index, -1)}
                  disabled={pending || index === 0}
                  aria-label="Mover para a esquerda"
                  className="rounded px-1 text-[10px] text-slate-300 disabled:opacity-30"
                >
                  ‹
                </button>
                {!image.isPrimary ? (
                  <button
                    type="button"
                    onClick={() => run(image.id, () => setStoreItemPrimaryImageAction(image.id))}
                    disabled={pending}
                    aria-label="Definir como principal"
                    title="Definir como principal"
                    className="rounded px-1 text-[10px] text-amber-300 disabled:opacity-30"
                  >
                    ★
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => moveImage(index, 1)}
                  disabled={pending || index === images.length - 1}
                  aria-label="Mover para a direita"
                  className="rounded px-1 text-[10px] text-slate-300 disabled:opacity-30"
                >
                  ›
                </button>
              </div>
              <button
                type="button"
                onClick={() => run(image.id, () => removeStoreItemImageAction(image.id))}
                disabled={pending}
                className="mt-1 w-full rounded bg-rose-500/10 py-0.5 text-[10px] text-rose-300 disabled:opacity-30"
              >
                {busyImageId === image.id && pending ? "..." : "Remover"}
              </button>
            </div>
          ))}
        </div>
      )}
      <StoreImageUpload storeItemId={storeItemId} onUploaded={(url) => run(null, () => addStoreItemImageAction(storeItemId, url))} />
      {message ? <p className="text-xs text-rose-300">{message}</p> : null}
    </div>
  );
}
