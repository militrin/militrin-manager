"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { QrScanner } from "./QrScanner";
import { parseWristbandScan } from "@/lib/operations/wristband-scan";

type WristbandSubmitResult = {
  success: boolean;
  message?: string;
  code?: string;
  holder_name?: string | null;
};

/**
 * Modal generico de "codigo da pulseira" -- reusado em 3 fluxos: vincular
 * pela ficha do ingresso, trocar (substituir a ativa) e o vinculo
 * OBRIGATORIO disparado por checkin/entrega quando o evento exige pulseira
 * e o ingresso ainda nao tem uma (nesse caso `mandatory` fica true).
 * Fechar/Cancelar/ESC/backdrop ABORTA a operacao pendente: nao vincula,
 * nao faz check-in, nao entrega kit. A leitura do QR so preenche o campo;
 * writer so na confirmacao (submitLabel).
 *
 * Leitura por QR reusa o QrScanner canonico (Turbo / Central). USB/manual
 * continua no campo -- leitores fisicos digitam como teclado.
 */
export function WristbandCodeModal({
  title,
  description,
  submitLabel,
  mandatory,
  eventId,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  mandatory?: boolean;
  eventId?: string | null;
  onSubmit: (code: string) => Promise<WristbandSubmitResult>;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkedHolder, setLinkedHolder] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanningRef = useRef(false);

  function handleAbort() {
    if (submitting) return;
    setScanning(false);
    setScanError(null);
    onClose();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || submitting) return;
      event.preventDefault();
      setScanning(false);
      setScanError(null);
      onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [submitting, onClose]);

  async function handleSubmit() {
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Informe o código da pulseira.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setLinkedHolder(null);
    const result = await onSubmit(trimmed);
    setSubmitting(false);
    if (!result.success) {
      setError(result.message ?? "Não foi possível concluir a operação.");
      setLinkedHolder(result.holder_name?.trim() || null);
      return;
    }
    onClose();
  }

  async function handleScan(raw: string) {
    if (scanningRef.current || submitting) return;
    const parsed = parseWristbandScan(raw);
    if (!parsed.ok) {
      setScanError(parsed.message);
      return;
    }
    scanningRef.current = true;
    setCode(parsed.code);
    setScanError(null);
    setScanning(false);
    scanningRef.current = false;
  }

  const relatedHref = linkedHolder && eventId
    ? `/operacoes?eventId=${encodeURIComponent(eventId)}&search=${encodeURIComponent(linkedHolder)}`
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={scanning || submitting ? undefined : handleAbort}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wristband-code-modal-title"
        className="w-full max-w-sm rounded-t-3xl border border-cyan-500/30 bg-slate-950 p-5 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 id="wristband-code-modal-title" className="text-base font-semibold text-slate-100">{title}</h3>
          <button
            type="button"
            onClick={handleAbort}
            disabled={submitting}
            aria-label="Fechar"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-700 px-3 text-lg leading-none text-slate-300 disabled:opacity-50"
          >
            ×
          </button>
        </div>
        {description ? <p className="mt-1 text-sm text-slate-400">{description}</p> : null}
        {mandatory ? (
          <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            Este evento exige pulseira vinculada para concluir esta operação.
          </p>
        ) : null}

        <label className="mt-4 block space-y-1">
          <span className="text-xs text-slate-300">Código da pulseira</span>
          <input
            autoFocus={!scanning}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); }}
            placeholder="Leitor USB, cole ou leia o QR"
            className="min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100"
          />
        </label>

        {error ? (
          <div className="mt-2 space-y-1" role="alert">
            <p className="text-xs text-rose-300">{error}</p>
            {linkedHolder ? <p className="text-xs text-slate-300">Titular: {linkedHolder}</p> : null}
            {relatedHref ? (
              <Link href={relatedHref} className="inline-flex min-h-11 items-center text-sm font-semibold text-cyan-200">
                Abrir ingresso relacionado
              </Link>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={handleAbort} disabled={submitting} className="min-h-12 rounded-xl border border-slate-700 px-4 text-sm text-slate-300 disabled:opacity-50">
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => { setScanError(null); setScanning(true); }}
            disabled={submitting}
            className="min-h-12 rounded-xl border border-cyan-500/50 px-4 text-sm font-semibold text-cyan-100 disabled:opacity-50"
          >
            Ler pulseira
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="min-h-12 rounded-xl bg-cyan-500 px-4 text-sm font-semibold text-cyan-950 disabled:opacity-50"
          >
            {submitting ? "Salvando..." : submitLabel}
          </button>
        </div>
      </div>

      {scanning ? (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-slate-950/90 p-4 sm:items-center"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="w-full max-w-md">
            <QrScanner
              title="Ler pulseira"
              onRead={handleScan}
              onCancel={() => { setScanning(false); setScanError(null); }}
              square
              hideManual
              guideLabel="Aproxime a pulseira até o QR ocupar boa parte da área"
              helpMessage="Aproxime a pulseira da câmera e evite reflexos."
            />
            {scanError ? (
              <p className="mt-3 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100" role="alert">
                {scanError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
