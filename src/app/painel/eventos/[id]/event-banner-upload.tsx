"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function EventBannerUpload({
  label,
  hint,
  value,
  onChange,
  aspectClassName = "aspect-video",
}: {
  label: string;
  hint: string;
  value: string | null;
  onChange: (url: string | null) => void;
  aspectClassName?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const supabase = createClient();
      const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from("event-banners").upload(path, file, { upsert: false });
      if (uploadError) { setError(uploadError.message); return; }
      const { data } = supabase.storage.from("event-banners").getPublicUrl(path);
      onChange(data.publicUrl);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-300">{label}</p>
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className={`w-full rounded-xl border border-slate-700 object-cover ${aspectClassName}`} />
      ) : (
        <div className={`flex w-full items-center justify-center rounded-xl border border-dashed border-slate-700 text-xs text-slate-500 ${aspectClassName}`}>
          Sem banner
        </div>
      )}
      <div className="flex items-center gap-2">
        <label className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-200">
          {uploading ? "Enviando..." : value ? "Trocar banner" : "Adicionar banner"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={uploading}
            onChange={(e) => { const file = e.target.files?.[0]; if (file) handleFile(file); e.target.value = ""; }}
          />
        </label>
        {value ? (
          <button type="button" onClick={() => onChange(null)} className="text-xs text-slate-500 underline">Remover</button>
        ) : null}
      </div>
      <p className="text-xs text-slate-500">{hint}</p>
      {error ? <p className="text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}
