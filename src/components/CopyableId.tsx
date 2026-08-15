"use client";

import { useEffect, useRef, useState } from "react";

export function CopyableId({ label, value }: { label: string; value: string | null }) {
  const [feedback, setFeedback] = useState<"idle" | "copied" | "error">("idle");
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);

  if (!value) {
    return <p className="text-xs text-slate-500">{label}: não disponível (dados cadastrais incompletos)</p>;
  }

  async function copyId() {
    try {
      await navigator.clipboard.writeText(value as string);
      setFeedback("copied");
    } catch {
      setFeedback("error");
    }
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback("idle"), 1800);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs">
      <span className="text-slate-400">{label}:</span>
      <span className="break-all font-mono text-slate-200">{value}</span>
      <button
        type="button"
        onClick={copyId}
        className="shrink-0 rounded-lg border border-slate-700 px-2 py-1 font-medium text-slate-300 transition hover:border-emerald-500/40 hover:text-emerald-200"
        aria-label={`Copiar ${label}`}
      >
        {feedback === "copied" ? "Copiado" : feedback === "error" ? "Tente novamente" : "Copiar"}
      </button>
    </div>
  );
}
