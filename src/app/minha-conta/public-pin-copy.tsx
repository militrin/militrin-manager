'use client';

import { useEffect, useRef, useState } from 'react';

export function PublicPinCopy({
  publicPin,
  compact = false,
}: {
  publicPin: string;
  compact?: boolean;
}) {
  const [feedback, setFeedback] = useState<'idle' | 'copied' | 'error'>('idle');
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);

  async function copyPin() {
    try {
      await navigator.clipboard.writeText(publicPin);
      setFeedback('copied');
    } catch {
      setFeedback('error');
    }

    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback('idle'), 1800);
  }

  return (
    <div
      className={compact
        ? 'mt-2 flex min-h-8 items-center gap-2'
        : 'mt-3 flex items-center justify-between gap-3 border-t border-slate-800/80 pt-3'}
    >
      <p className="min-w-0 text-xs text-slate-400">
        <span className="block">PIN da conta</span>
        <span className="font-mono font-semibold tracking-[0.12em] text-slate-200">{publicPin}</span>
      </p>
      <button
        type="button"
        onClick={copyPin}
        className={compact
          ? 'inline-flex h-8 shrink-0 items-center rounded-lg border border-slate-700 px-2.5 text-[11px] font-medium text-slate-300 transition hover:border-(--brand-500)/40 hover:text-(--brand-200)'
          : 'shrink-0 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-(--brand-500)/40 hover:text-(--brand-200)'}
        aria-label="Copiar PIN da conta"
      >
        {feedback === 'copied' ? 'Copiado' : feedback === 'error' ? 'Tente novamente' : 'Copiar'}
      </button>
    </div>
  );
}
