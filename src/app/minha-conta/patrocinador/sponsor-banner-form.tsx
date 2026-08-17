'use client';

import Image from 'next/image';
import { useState } from 'react';
import { SponsorBannerUpload } from '@/components/admin/SponsorBannerUpload';
import { updateMySponsorBannerAction, updateMySponsorLinkAction } from './actions';

export function SponsorBannerForm({
  sponsorId,
  sponsorName,
  initialBannerUrl,
  initialLinkUrl,
}: {
  sponsorId: string;
  sponsorName: string;
  initialBannerUrl: string | null;
  initialLinkUrl: string | null;
}) {
  const [bannerUrl, setBannerUrl] = useState(initialBannerUrl);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [linkUrl, setLinkUrl] = useState(initialLinkUrl ?? '');
  const [linkMessage, setLinkMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [savingLink, setSavingLink] = useState(false);

  async function handleChange(url: string | null) {
    setBannerUrl(url);
    setSaving(true);
    setMessage(null);
    const result = await updateMySponsorBannerAction(url);
    setMessage({ type: result.success ? 'success' : 'error', text: result.message });
    setSaving(false);
  }

  async function saveLink() {
    setSavingLink(true);
    setLinkMessage(null);
    const result = await updateMySponsorLinkAction(linkUrl.trim() || null);
    setLinkMessage({ type: result.success ? 'success' : 'error', text: result.message });
    setSavingLink(false);
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

        <div className="mt-5 border-t border-slate-800 pt-4">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Link de destino do banner</span>
            <input
              type="url"
              placeholder="https://exemplo.com.br"
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm"
            />
          </label>
          <p className="mt-1 text-xs text-slate-500">Opcional. Ao clicar no banner, o usuário será direcionado para este endereço.</p>
          <button
            type="button"
            onClick={saveLink}
            disabled={savingLink}
            className="mt-2 rounded-xl border border-slate-700 px-4 py-2 text-xs text-slate-200 disabled:opacity-60"
          >
            {savingLink ? 'Salvando...' : 'Salvar link'}
          </button>
          {linkMessage ? (
            <p className={`mt-2 text-xs ${linkMessage.type === 'success' ? 'text-emerald-300' : 'text-rose-300'}`}>{linkMessage.text}</p>
          ) : null}
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold text-slate-200">Como vai aparecer na Home</p>
        <p className="mt-1 text-xs text-slate-500">Pré-visualização do card exibido aos usuários.</p>
        <div className="mt-3 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950">
          <div className="relative aspect-[4/3] w-full bg-slate-900">
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
