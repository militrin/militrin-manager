"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Padrao oficial de arte de evento (auditoria P0 "cortes de banner"): 16:9,
// igual pro banner de capa e pro banner do card -- ver MilitrinEventArtwork
// (mesmo componente exibe os dois em toda tela publica/Minha Conta/admin).
// Antes hero e card tinham proporcoes recomendadas diferentes (8:3 vs 16:9)
// mas na pratica os organizadores sempre subiam a MESMA arte (16:9) nos
// dois campos -- unificar elimina o corte imprevisivel sem exigir uma
// segunda arte so pra mobile.
const OFFICIAL_RATIO = 16 / 9;
const RATIO_WARN_THRESHOLD = 0.12; // 12% de desvio antes de avisar (nao bloqueia upload)

export function EventBannerUpload({
  label,
  hint,
  value,
  onChange,
  recommendedWidth = 1600,
  recommendedHeight = 900,
  minWidth = 1280,
  minHeight = 720,
}: {
  label: string;
  hint: string;
  value: string | null;
  onChange: (url: string | null) => void;
  /** Numeros da linha "Tamanho recomendado" sempre visivel -- default e o
      padrao oficial de arte de evento (16:9, ver MilitrinEventArtwork).
      Sobrescrito pelo banner de atracao, que e uma entidade separada com
      sua propria resolucao (mesma proporcao 16:9, tamanho menor). */
  recommendedWidth?: number;
  recommendedHeight?: number;
  minWidth?: number;
  minHeight?: number;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ratioWarning, setRatioWarning] = useState<string | null>(null);

  // Mensagem em linguagem simples, sem razao decimal tecnica (ex.: nunca
  // "proporcao 1.42:1") -- o organizador nao precisa entender o calculo,
  // so que a imagem pode ser cortada e qual tamanho evita isso.
  function checkRatio(width: number, height: number) {
    if (!width || !height) { setRatioWarning(null); return; }
    const ratio = width / height;
    const deviation = Math.abs(ratio - OFFICIAL_RATIO) / OFFICIAL_RATIO;
    if (deviation > RATIO_WARN_THRESHOLD) {
      setRatioWarning(
        `Esta imagem tem ${width} × ${height}px — um formato diferente do recomendado, e poderá sofrer cortes. Para melhor resultado, use uma imagem 16:9, preferencialmente ${recommendedWidth} × ${recommendedHeight}px.`
      );
    } else {
      setRatioWarning(null);
    }
  }

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
        <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt=""
            className="h-full w-full object-cover"
            onLoad={(e) => checkRatio(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          />
          {/* Guia de safe area: logotipo/textos importantes da arte devem
              ficar dentro desta moldura tracejada (90% da largura, 80% da
              altura, centralizada) pra sobreviver ao corte do object-cover
              mesmo quando a imagem enviada nao bate exatamente 16:9. */}
          <div className="pointer-events-none absolute inset-[5%_5%_10%_5%] rounded-md border border-dashed border-amber-300/50" />
        </div>
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-dashed border-slate-700 text-xs text-slate-500">
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
          <button type="button" onClick={() => { onChange(null); setRatioWarning(null); }} className="text-xs text-slate-500 underline">Remover</button>
        ) : null}
      </div>
      <div className="space-y-1 text-xs text-slate-500">
        <p>{hint}</p>
        <p>Tamanho recomendado: {recommendedWidth} × {recommendedHeight}px (16:9). Mínimo recomendado: {minWidth} × {minHeight}px.</p>
        <p>Mantenha logos, datas e textos importantes dentro da área tracejada.</p>
      </div>
      {ratioWarning ? <p className="text-xs text-amber-300">{ratioWarning}</p> : null}
      {error ? <p className="text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}
