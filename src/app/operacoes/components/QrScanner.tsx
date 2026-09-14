'use client';

import { useEffect, useState } from 'react';
import { useQrCameraScanner } from './useQrCameraScanner';

const DEFAULT_HELP_AFTER_MS = 4500;

export function QrScanner({
  title,
  onRead,
  onCancel,
  compact = false,
  square = false,
  hideManual = false,
  guideLabel,
  helpMessage,
  helpAfterMs = DEFAULT_HELP_AFTER_MS,
}: {
  title: string;
  onRead: (value: string) => Promise<void>;
  onCancel?: () => void;
  compact?: boolean;
  /** Preview quadrado — estação Turbo no celular. */
  square?: boolean;
  /** Esconde o campo USB/manual da primeira dobra. */
  hideManual?: boolean;
  /** Rotulo mostrado ACIMA do video, junto da guia discreta de cantos. Sem isso, nenhuma guia e desenhada — salvo `square`. */
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
  const showGuide = Boolean(guideLabel) || square;
  const { videoRef, message, status, lastDetectedAt, debugInfo, tuningInfo } = useQrCameraScanner(onRead, { smallQrMode });
  const [manual, setManual] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    if (!helpMessage || status !== 'scanning') return;
    // Reinicia a contagem sempre que uma leitura acontece (lastDetectedAt
    // muda) -- o cleanup cancela o timer pendente da tentativa anterior,
    // entao "aproxime a pulseira" nunca aparece logo depois de uma leitura
    // bem-sucedida.
    const timer = window.setTimeout(() => setShowHelp(true), helpAfterMs);
    return () => window.clearTimeout(timer);
  }, [helpMessage, helpAfterMs, status, lastDetectedAt]);

  const videoClass = square
    ? 'aspect-square w-full rounded-[1.75rem] bg-black object-cover'
    : 'aspect-video w-full rounded-2xl bg-black object-cover';

  return (
    <div className={compact || square ? 'space-y-3' : 'rounded-3xl border border-slate-700 bg-slate-900 p-5'}>
      {square ? (
        <p className="text-center text-sm font-semibold text-slate-300">{status === 'error' ? message : title}</p>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">{title}</h2>
            <p className="text-sm text-slate-400">{message}</p>
          </div>
          {onCancel ? (
            <button type="button" onClick={onCancel} className="min-h-11 rounded-xl border border-slate-700 px-3 py-2 text-sm">
              Cancelar
            </button>
          ) : null}
        </div>
      )}
      {/* Instrucao da guia FORA da imagem -- em cima do texto sobreposto ao
          video escondia parte do QR e dificultava avaliar foco/nitidez. Dentro
          do video sobra so a moldura discreta (cantos), sem nenhum texto. */}
      {guideLabel ? <p className="mt-1 text-center text-xs font-semibold text-cyan-200">{guideLabel}</p> : null}
      <div className={`relative ${square ? 'mx-auto w-full max-w-[min(100%,22rem)] overflow-hidden rounded-[1.75rem] ring-4 ring-cyan-400/70 ring-offset-4 ring-offset-slate-950' : 'mt-2'}`}>
        <video ref={videoRef} playsInline muted className={videoClass} />
        {showGuide ? (
          // Area MENOR que a versao anterior (era max-72) -- pensada
          // especificamente pro QR fisico pequeno da pulseira: quanto menor a
          // guia, mais o operador precisa aproximar pra preenche-la, e mais
          // pixels efetivos o QR ocupa no frame analisado.
          <div aria-hidden className={`pointer-events-none absolute inset-0 flex items-center justify-center ${square ? 'p-8' : 'p-10'}`}>
            <div className={`relative h-full w-full ${square ? 'max-h-none max-w-none' : 'max-h-48 max-w-48'}`}>
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
      {square && onCancel ? (
        <button type="button" onClick={onCancel} className="min-h-12 w-full rounded-2xl border border-slate-700 text-base font-semibold text-slate-200">
          Cancelar
        </button>
      ) : null}
      {helpMessage && showHelp ? (
        <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{helpMessage}</p>
      ) : null}
      {status === 'error' && !square ? <p className="mt-2 text-sm text-rose-300">{message}</p> : null}
      {hideManual ? (
        <details className="rounded-2xl border border-slate-800 bg-slate-950/60 px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-slate-400">Código manual / USB</summary>
          <div className="mt-3 flex gap-2">
            <input
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && manual.trim()) void onRead(manual);
              }}
              placeholder="Código"
              className="min-h-12 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 text-base"
            />
            <button
              type="button"
              onClick={() => void onRead(manual)}
              disabled={!manual.trim()}
              className="min-h-12 rounded-xl bg-cyan-500 px-4 text-sm font-semibold text-cyan-950 disabled:opacity-50"
            >
              Ler
            </button>
          </div>
        </details>
      ) : (
        <div className="mt-3 flex gap-2">
          {square && !showManual ? (
            <button type="button" onClick={() => setShowManual(true)} className="min-h-11 w-full text-sm text-slate-500">
              Código manual / USB
            </button>
          ) : (
            <>
              <input
                value={manual}
                onChange={(event) => setManual(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && manual.trim()) void onRead(manual);
                }}
                placeholder="Leitor USB ou código manual"
                className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => void onRead(manual)}
                disabled={!manual.trim()}
                className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950 disabled:opacity-50"
              >
                Ler
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
