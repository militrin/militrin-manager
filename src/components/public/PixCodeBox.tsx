'use client';

import { useState } from 'react';

export function PixCodeBox({ code }: { code: string }) {
  const [message, setMessage] = useState<string | null>(null);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setMessage('Codigo PIX copiado.');
    } catch {
      setMessage('Nao foi possivel copiar o codigo PIX.');
    }
  }

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-200">
      <p className="mb-2">Codigo PIX</p>
      <textarea readOnly value={code} className="h-24 w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs" />
      <button type="button" onClick={copyCode} className="mt-2 rounded-xl border border-slate-600 px-3 py-2 text-xs text-slate-200">
        Copiar codigo PIX
      </button>
      {message ? <p className="mt-2 text-xs text-emerald-200">{message}</p> : null}
    </div>
  );
}
