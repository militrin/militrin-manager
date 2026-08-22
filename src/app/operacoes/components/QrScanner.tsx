'use client';

import { useEffect, useState } from 'react';
import { useQrCameraScanner } from './useQrCameraScanner';

const DEFAULT_HELP_AFTER_MS = 4500;

export function QrScanner({
  title,
  onRead,
  onCancel,
  compact = false,
  guideLabel,
  helpMessage,
  helpAfterMs = DEFAULT_HELP_AFTER_MS,
}: {
  title: string;
  onRead: (value: string) => Promise<void>;
  onCancel?: () => void;
  compact?: boolean;
  /** Rotulo mostrado ACIMA do video, junto da guia discreta de cantos. Sem isso, nenhuma guia e desenhada. */
  guideLabel?: string;
  /** Dica extra mostrada apos `helpAfterMs` sem nenhuma leitura bem-sucedida. */
  helpMessage?: string;
  helpAfterMs?: number;
}) {
  // guideLabel hoje e exclusivo do contexto de pulseira (Turbo + Ver
  // pulseira vinculada) -- reaproveitado como sinal de "QR fisico pequeno"
  // pro hook (crops extras + zoom mais forte quando suportado), sem precisar
  // de mais um prop redundante nos 2 unicos chamadores atuais.
  const smallQrMode = Boolean(guideLabel);
  const { videoRef, message, status, lastDetectedAt, debugInfo, tuningInfo } = useQrCameraScanner(onRead, { smallQrMode });
  const [manual, setManual] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (!helpMessage || status !== 'scanning') return;
    // Reinicia a contagem sempre que uma leitura acontece (lastDetectedAt
    // muda) -- o cleanup cancela o timer pendente da tentativa anterior,
    // entao "aproxime a pulseira" nunca aparece logo depois de uma leitura
    // bem-sucedida.
    const timer = window.setTimeout(() => setShowHelp(true), helpAfterMs);
    return () => window.clearTimeout(timer);
  }, [helpMessage, helpAfterMs, status, lastDetectedAt]);

  return <div className={compact ? 'space-y-3' : 'rounded-3xl border border-slate-700 bg-slate-900 p-5'}>
    <div className="flex items-center justify-between gap-3"><div><h2 className="text-xl font-bold">{title}</h2><p className="text-sm text-slate-400">{message}</p></div>{onCancel ? <button type="button" onClick={onCancel} className="rounded-xl border border-slate-700 px-3 py-2 text-sm">Cancelar</button> : null}</div>
    {/* Instrucao da guia FORA da imagem -- em cima do texto sobreposto ao
        video escondia parte do QR e dificultava avaliar foco/nitidez. Dentro
        do video sobra so a moldura discreta (cantos), sem nenhum texto. */}
    {guideLabel ? <p className="mt-3 text-center text-xs font-semibold text-cyan-200">{guideLabel}</p> : null}
    <div className="relative mt-2">
      <video ref={videoRef} playsInline muted className="aspect-video w-full rounded-2xl bg-black object-cover" />
      {guideLabel ? (
        // Area MENOR que a versao anterior (era max-72) -- pensada
        // especificamente pro QR fisico pequeno da pulseira: quanto menor a
        // guia, mais o operador precisa aproximar pra preenche-la, e mais
        // pixels efetivos o QR ocupa no frame analisado.
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center p-10">
          <div className="relative h-full max-h-48 w-full max-w-48">
            <span className="absolute left-0 top-0 h-7 w-7 rounded-tl-lg border-l-2 border-t-2 border-cyan-400/70" />
            <span className="absolute right-0 top-0 h-7 w-7 rounded-tr-lg border-r-2 border-t-2 border-cyan-400/70" />
            <span className="absolute bottom-0 left-0 h-7 w-7 rounded-bl-lg border-b-2 border-l-2 border-cyan-400/70" />
            <span className="absolute bottom-0 right-0 h-7 w-7 rounded-br-lg border-b-2 border-r-2 border-cyan-400/70" />
          </div>
        </div>
      ) : null}
      {/* Overlay de MEDICAO -- SO em development (eliminado do bundle de
          producao pelo Next.js em build time; nunca aparece pro operador
          real). Existe pra medir em hardware fisico (iPhone) o que antes so
          dava pra estimar por calculo: resolucao real do video, qual crop
          foi tentado por ultimo e a escala aplicada, mais um resumo de
          zoom/foco/torch (reporta o que foi de fato APLICADO, nao so
          tentado). */}
      {process.env.NODE_ENV === 'development' && guideLabel && (debugInfo || tuningInfo) ? (
        <div aria-hidden className="pointer-events-none absolute right-2 top-2 max-w-[70%] rounded-md bg-black/75 px-2 py-1 font-mono text-[9px] leading-tight text-lime-300">
          {debugInfo ? <p>{debugInfo.videoWidth}×{debugInfo.videoHeight} · crop {debugInfo.cropLabel} · {debugInfo.scale}x</p> : null}
          {tuningInfo ? (
            <p>
              zoom {tuningInfo.zoomApplied ? `${(tuningInfo.zoomValue ?? 0).toFixed(1)} aplicado` : 'não aplicado'} · foco {tuningInfo.focusModeApplied ? 'contínuo' : 'padrão'} · torch {tuningInfo.torchAvailable ? 'disponível' : 'indisponível'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
    {helpMessage && showHelp ? (
      <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{helpMessage}</p>
    ) : null}
    <div className="mt-3 flex gap-2"><input value={manual} onChange={(event) => setManual(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && manual.trim()) void onRead(manual); }} placeholder="Leitor USB ou código manual" className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm" /><button type="button" onClick={() => void onRead(manual)} disabled={!manual.trim()} className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950 disabled:opacity-50">Ler</button></div>
  </div>;
}
