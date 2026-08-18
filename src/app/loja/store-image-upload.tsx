"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Botao de upload de 1 arquivo para o bucket "store-item-images". O path
 * "{storeItemId}/{arquivo}" e a fronteira de seguranca usada pela RLS do
 * bucket (ver migration store_item_image_gallery) -- so pode ser chamado
 * com o id de um item que ja existe.
 */
export function StoreImageUpload({ storeItemId, onUploaded, label }: { storeItemId: string; onUploaded: (url: string) => void; label?: string }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const supabase = createClient();
      const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${storeItemId}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from("store-item-images").upload(path, file, { upsert: false });
      if (uploadError) { setError(uploadError.message); return; }
      const { data } = supabase.storage.from("store-item-images").getPublicUrl(path);
      onUploaded(data.publicUrl);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <label className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-200">
        {uploading ? "Enviando..." : label ?? "Adicionar foto"}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          disabled={uploading}
          onChange={(e) => { const file = e.target.files?.[0]; if (file) handleFile(file); e.target.value = ""; }}
        />
      </label>
      {error ? <p className="mt-1 text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}
