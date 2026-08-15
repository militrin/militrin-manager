"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function StoreImageUpload({ value, onChange }: { value: string | null; onChange: (url: string | null) => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const supabase = createClient();
      const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from("store-item-images").upload(path, file, { upsert: false });
      if (uploadError) { setError(uploadError.message); return; }
      const { data } = supabase.storage.from("store-item-images").getPublicUrl(path);
      onChange(data.publicUrl);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className="h-16 w-16 rounded-lg border border-slate-700 object-cover" />
      ) : (
        <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-slate-700 text-[10px] text-slate-500">Sem foto</div>
      )}
      <div>
        <label className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-200">
          {uploading ? "Enviando..." : value ? "Trocar foto" : "Adicionar foto"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={uploading}
            onChange={(e) => { const file = e.target.files?.[0]; if (file) handleFile(file); e.target.value = ""; }}
          />
        </label>
        {value ? (
          <button type="button" onClick={() => onChange(null)} className="ml-2 text-xs text-slate-500 underline">Remover</button>
        ) : null}
        {error ? <p className="mt-1 text-xs text-rose-300">{error}</p> : null}
      </div>
    </div>
  );
}
