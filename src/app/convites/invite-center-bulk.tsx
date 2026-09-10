"use client";

import { useState, useTransition } from "react";
import {
  INVITE_CENTER_BULK_BATCH_SIZE,
  INVITE_CENTER_BULK_DELAY_MS,
} from "@/lib/invites/invite-center-status";
import {
  previewInviteCenterBulkResendAction,
  processInviteCenterBulkChunkAction,
  startInviteCenterBulkResendAction,
} from "./actions";
import type { InviteCenterJobProgress } from "@/lib/invites/invite-center-types";

type Preview = {
  expired_or_failed?: number;
  unique_emails?: number;
  conflicts?: number;
  already_active?: number;
  sample_masked?: string[];
  sent_last_24h?: number;
  batch_size?: number;
  sends_nothing?: boolean;
};

export function InviteCenterBulkPanel({
  canBulkResend,
  sentLast24h,
  activeJob,
}: {
  canBulkResend: boolean;
  sentLast24h: number;
  activeJob?: InviteCenterJobProgress | null;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<InviteCenterJobProgress | null>(activeJob ?? null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function loadPreview() {
    setMessage(null);
    startTransition(async () => {
      const result = await previewInviteCenterBulkResendAction();
      if (!result.success) {
        setMessage(result.message);
        return;
      }
      setPreview((result.preview ?? {}) as Preview);
    });
  }

  async function run(jobId: string) {
    for (;;) {
      const result = await processInviteCenterBulkChunkAction(jobId);
      if (!result.success) {
        setMessage(result.message);
        break;
      }
      if (result.job) setJob(result.job as InviteCenterJobProgress);
      if (!result.processed) break;
      await new Promise((resolve) => window.setTimeout(resolve, INVITE_CENTER_BULK_DELAY_MS));
    }
  }

  function confirmStart() {
    setConfirmOpen(false);
    startTransition(async () => {
      const started = await startInviteCenterBulkResendAction();
      if (!started.success) {
        setMessage(started.message);
        return;
      }
      const jobId = String((started.job as { job_id?: string })?.job_id ?? "");
      if (!jobId) {
        setMessage("Job não iniciado.");
        return;
      }
      await run(jobId);
    });
  }

  if (!canBulkResend) return null;

  const waiting = job ? Math.max(0, Number(job.total_count) - Number(job.processed_count)) : 0;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-white">Envio em massa</h2>
          <p className="mt-1 text-sm text-slate-400">
            Reenviar links Auth expirados não dispara sozinho. Preview não envia e-mail.
            Lote de {INVITE_CENTER_BULK_BATCH_SIZE} · intervalo de {INVITE_CENTER_BULK_DELAY_MS / 1000}s · enviados nas últimas 24h: {sentLast24h}.
          </p>
        </div>
        <button type="button" onClick={loadPreview} disabled={pending} className="h-10 rounded-xl border border-amber-400/40 px-4 text-sm text-amber-100 disabled:opacity-50">
          {pending ? "Carregando..." : "Reenviar links expirados"}
        </button>
      </div>
      {job ? (
        <div className="mt-4 grid gap-2 text-sm sm:grid-cols-4">
          <p>Fila: {job.total_count}</p>
          <p>Enviados: {job.sent_count}</p>
          <p>Falhas: {job.failed_count}</p>
          <p>Aguardando: {waiting}</p>
        </div>
      ) : null}
      {preview ? (
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-sm">
          <p>{preview.expired_or_failed ?? 0} links Auth expirados ou falhas de envio</p>
          <p>{preview.unique_emails ?? 0} e-mails únicos</p>
          <p>{preview.conflicts ?? 0} conflitos</p>
          <p>{preview.already_active ?? 0} contas já ativadas</p>
          {preview.sample_masked?.length ? <p className="mt-2 text-slate-400">Amostra: {preview.sample_masked.join(", ")}</p> : null}
          <p className="mt-2 text-xs text-slate-500">Este preview não envia nada.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => setPreview(null)} className="h-10 rounded-xl border border-slate-700 px-4">Cancelar</button>
            <button type="button" onClick={() => setConfirmOpen(true)} disabled={!preview.expired_or_failed} className="h-10 rounded-xl bg-amber-400 px-4 font-semibold text-amber-950 disabled:opacity-50">Confirmar reenvio</button>
          </div>
        </div>
      ) : null}
      {confirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <h3 className="text-lg font-semibold text-white">Confirmar reenvio em massa</h3>
            <p className="mt-2 text-sm text-slate-300">
              {preview?.expired_or_failed ?? 0} links Auth expirados/falhos serão enfileirados. Concluídos, cadastro pendente e ação administrativa ficam de fora. O envio segue em lotes de {preview?.batch_size ?? INVITE_CENTER_BULK_BATCH_SIZE}, sem disparo simultâneo.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmOpen(false)} className="rounded-xl border border-slate-700 px-3 py-2 text-sm">Cancelar</button>
              <button type="button" onClick={confirmStart} className="rounded-xl bg-amber-400 px-3 py-2 text-sm font-semibold text-amber-950">Confirmar reenvio</button>
            </div>
          </div>
        </div>
      ) : null}
      {message ? <p className="mt-3 text-sm text-rose-200">{message}</p> : null}
    </section>
  );
}
