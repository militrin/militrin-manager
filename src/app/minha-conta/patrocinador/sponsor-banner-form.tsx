'use client';

import Image from 'next/image';
import { useState } from 'react';
import { SponsorBannerUpload } from '@/components/admin/SponsorBannerUpload';
import { updateMySponsorBannerAction } from './actions';

export function SponsorBannerForm({ sponsorId, sponsorName, initialBannerUrl }: { sponsorId: string; sponsorName: string; initialBannerUrl: string | null }) {
  const [bannerUrl, setBannerUrl] = useState(initialBannerUrl);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleChange(url: string | null) {
    setBannerUrl(url);
    setSaving(true);
    setMessage(null);
    const result = await updateMySponsorBannerAction(url);
    setMessage({ type: result.success ? 'success' : 'error', text: result.message });
    setSaving(false);
  }

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div>
        <p className="text-sm font-semibold text-slate-200">Seu banner</p>
        <p className="mt-1 text-xs text-slate-500">Substituir envia um novo arquivo e troca o anterior imediatamente — só existe um banner ativo por vez.</p>
        <div className="mt-3">
          <SponsorBannerUpload sponsorId={sponsorId} value={bannerUrl} onChange={handleChange} />
        </div>
        {saving ? <p className="mt-2 text-xs text-slate-400">Salvando...</p> : null}
        {message ? (
          <p className={`mt-2 text-xs ${message.type === 'success' ? 'text-emerald-300' : 'text-rose-300'}`}>{message.text}</p>
        ) : null}
      </div>

      <div>
        <p className="text-sm font-semibold text-slate-200">Como vai aparecer na Home</p>
        <p className="mt-1 text-xs text-slate-500">Pré-visualização do card exibido aos usuários.</p>
        <div className="mt-3 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
          <div className="relative aspect-[16/10] w-full bg-slate-900">
            {bannerUrl ? (
              <Image src={bannerUrl} alt={sponsorName} fill unoptimized className="object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-slate-600">Sem banner ainda</div>
            )}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
              <p className="truncate text-xs font-semibold text-white/90">{sponsorName}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
