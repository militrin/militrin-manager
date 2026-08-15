'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// Bucket proprio "sponsor-banners" (nao "event-banners"): a policy de
// storage exige que o path comece pelo proprio sponsorId do patrocinador
// (ver migration 20260815006600_sponsors_module.sql) -- e essa fronteira,
// nao apenas a UI, que impede um patrocinador de alterar o banner de outro.
export function SponsorBannerUpload({
  sponsorId,
  value,
  onChange,
}: {
  sponsorId: string;
  value: string | null;
  onChange: (url: string | null) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const supabase = createClient();
      const extension = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `${sponsorId}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from('sponsor-banners').upload(path, file, { upsert: false });
      if (uploadError) { setError(uploadError.message); return; }
      const { data } = supabase.storage.from('sponsor-banners').getPublicUrl(path);
      onChange(data.publicUrl);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="" className="aspect-[16/10] w-full rounded-xl border border-slate-700 object-cover" />
      ) : (
        <div className="flex aspect-[16/10] w-full items-center justify-center rounded-xl border border-dashed border-slate-700 text-xs text-slate-500">
          Sem banner
        </div>
      )}
      <div className="flex items-center gap-2">
        <label className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-200">
          {uploading ? 'Enviando...' : value ? 'Trocar banner' : 'Adicionar banner'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={uploading}
            onChange={(event) => { const file = event.target.files?.[0]; if (file) handleFile(file); event.target.value = ''; }}
          />
        </label>
        {value ? (
          <button type="button" onClick={() => onChange(null)} className="text-xs text-slate-500 underline">Remover</button>
        ) : null}
      </div>
      <p className="text-xs text-slate-500">Proporção recomendada: 16:10 (ex.: 1200x750px). PNG, JPEG ou WebP, até 5MB.</p>
      {error ? <p className="text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}
