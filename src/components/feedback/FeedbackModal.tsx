'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Image as ImageIcon, Loader2, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { buildFeedbackTechnicalContext, extractEventSlugFromPath } from '@/lib/feedback/technical-context';
import { submitFeedbackAction } from './feedback-actions';

const TYPE_OPTIONS: Array<{ value: 'problem' | 'suggestion' | 'question'; label: string }> = [
  { value: 'problem', label: 'Problema' },
  { value: 'suggestion', label: 'Sugestão' },
  { value: 'question', label: 'Dúvida' },
];

// Bucket privado "feedback-screenshots" -- diferente de sponsor-banners/
// event-banners (publicos), aqui nao existe URL publica: o preview local usa
// URL.createObjectURL (nunca sobe base64 pro banco) e o que persiste no
// relato e so o PATH do objeto, nunca uma URL assinada (essa e gerada sob
// demanda pelo admin, respeitando a mesma RLS de leitura do bucket).
export function FeedbackModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const [type, setType] = useState<'problem' | 'suggestion' | 'question'>('problem');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  function resetForm() {
    setType('problem');
    setMessage('');
    setFile(null);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreviewUrl(null);
    setError(null);
    setSent(false);
  }

  function handleClose() {
    onClose();
    // So limpa depois do fechamento visual, evitando "piscar" o form vazio.
    setTimeout(resetForm, 200);
  }

  function handleFileChange(selected: File | null) {
    setError(null);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (!selected) {
      setFile(null);
      previewUrlRef.current = null;
      setPreviewUrl(null);
      return;
    }
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowed.includes(selected.type)) {
      setError('Formato de imagem não suportado. Use PNG, JPEG ou WebP.');
      return;
    }
    if (selected.size > 5 * 1024 * 1024) {
      setError('Imagem maior que 5MB.');
      return;
    }
    const url = URL.createObjectURL(selected);
    previewUrlRef.current = url;
    setFile(selected);
    setPreviewUrl(url);
  }

  async function handleSubmit() {
    setError(null);
    if (!message.trim()) {
      setError('Descreva o que aconteceu.');
      return;
    }

    setSubmitting(true);
    try {
      let screenshotPath: string | null = null;
      if (file) {
        setUploading(true);
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          setError('Sessão expirada. Recarregue a página e tente novamente.');
          return;
        }
        const extension = file.name.split('.').pop()?.toLowerCase() || 'jpg';
        const path = `${user.id}/${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage.from('feedback-screenshots').upload(path, file, { upsert: false });
        if (uploadError) {
          setError('Não foi possível enviar a imagem. Tente novamente.');
          return;
        }
        screenshotPath = path;
        setUploading(false);
      }

      const result = await submitFeedbackAction({
        type,
        message: message.trim(),
        screenshotPath,
        pagePath: pathname ?? null,
        eventSlugHint: extractEventSlugFromPath(pathname ?? ''),
        technicalContext: buildFeedbackTechnicalContext(),
      });

      if (!result.success) {
        setError(result.message);
        return;
      }
      setSent(true);
    } finally {
      setSubmitting(false);
      setUploading(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-0 sm:items-center sm:p-4">
      <button type="button" aria-label="Fechar" onClick={handleClose} className="absolute inset-0 cursor-default" />
      <div className="relative flex max-h-[92vh] w-full max-w-md flex-col overflow-y-auto rounded-t-[2rem] border border-slate-800 bg-slate-900 p-5 shadow-2xl sm:rounded-[2rem] sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-white">Reportar problema</h3>
          <button type="button" onClick={handleClose} aria-label="Fechar" className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700 text-slate-300">
            <X size={14} />
          </button>
        </div>

        {sent ? (
          <div className="mt-6 space-y-4 text-center">
            <p className="text-2xl">🙏</p>
            <p className="text-sm font-semibold text-white">Obrigado! Recebemos seu relato.</p>
            <p className="text-xs text-slate-400">Nossa equipe vai analisar em breve.</p>
            <button
              type="button"
              onClick={handleClose}
              className="mt-2 inline-flex h-10 w-full items-center justify-center rounded-2xl bg-(--brand-500) text-sm font-semibold text-white"
            >
              Fechar
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <span className="mb-1.5 block text-sm text-slate-300">Tipo</span>
              <div className="grid grid-cols-3 gap-2">
                {TYPE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setType(option.value)}
                    className={`rounded-xl border px-2 py-2 text-xs font-semibold transition ${
                      type === option.value
                        ? 'border-(--brand-500) bg-(--brand-500)/15 text-(--brand-100)'
                        : 'border-slate-800 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="block space-y-1.5 text-sm">
              <span className="text-slate-300">Descreva o que aconteceu</span>
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={4}
                maxLength={4000}
                placeholder="Conte com o máximo de detalhes que puder..."
                className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-(--brand-500)"
              />
            </label>

            <div>
              <span className="mb-1.5 block text-sm text-slate-300">Imagem (opcional)</span>
              {previewUrl ? (
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl} alt="" className="max-h-40 w-full rounded-xl border border-slate-700 object-cover" />
                  <button
                    type="button"
                    onClick={() => handleFileChange(null)}
                    className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-slate-200"
                    aria-label="Remover imagem"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <label className="flex h-16 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-slate-700 text-xs text-slate-400 hover:border-slate-500">
                  <ImageIcon size={15} />
                  Anexar screenshot
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(event) => handleFileChange(event.target.files?.[0] ?? null)}
                  />
                </label>
              )}
              <p className="mt-1 text-[11px] text-slate-500">PNG, JPEG ou WebP, até 5MB.</p>
            </div>

            {error ? <p className="text-xs text-rose-300">{error}</p> : null}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-(--brand-500) text-sm font-semibold text-white transition hover:bg-(--brand-600) disabled:opacity-60"
            >
              {submitting ? <Loader2 size={15} className="animate-spin" /> : null}
              {uploading ? 'Enviando imagem...' : submitting ? 'Enviando...' : 'Enviar'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
