"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  getImportAccountInviteOperationalStatusAction,
  previewImportAccountInviteJobAction,
  processImportAccountInviteJobChunkAction,
  listImportAccountInviteJobFailuresAction,
  retryImportAccountInviteJobFailuresAction,
  startImportAccountInviteJobAction,
  type ImportAccountInviteOperationalCounts,
} from "@/app/cadastros/actions";

type Job = { id: string; status: string; total_count: number; eligible_count: number; processed_count: number; sent_count: number; skipped_count: number; failed_count: number };

const EMPTY_COUNTS: ImportAccountInviteOperationalCounts = {
  total: 0,
  withoutInvite: 0,
  pendingInvite: 0,
  claimed: 0,
  expiredInvite: 0,
  failed: 0,
};

export function ImportAccountInvites({ importBatchId, importedCount }: { importBatchId: string; importedCount: number }) {
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewImportAccountInviteJobAction>> | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [counts, setCounts] = useState<ImportAccountInviteOperationalCounts>(EMPTY_COUNTS);
  const [message, setMessage] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [failures, setFailures] = useState<Array<Record<string, unknown>>>([]);
  const [pending, startTransition] = useTransition();
  const running = useRef(false);

  const loadPersistentState = useCallback(async () => {
    const [previewResult, statusResult] = await Promise.all([
      previewImportAccountInviteJobAction(importBatchId),
      getImportAccountInviteOperationalStatusAction(importBatchId),
    ]);
    setPreview(previewResult);
    if (!statusResult.success) {
      setMessage(statusResult.message);
      return;
    }
    setJob(statusResult.job as Job | null);
    setCounts(statusResult.counts);
  }, [importBatchId]);

  useEffect(() => {
    startTransition(async () => {
      await loadPersistentState();
    });
  }, [importBatchId, loadPersistentState, startTransition]);

  async function run(jobId: string) {
    if (running.current) return;
    running.current = true;
    setProcessing(true);
    try {
      for (;;) {
        const result = await processImportAccountInviteJobChunkAction(jobId);
        if (!result.success) { setMessage(result.message); break; }
        setJob(result.job as Job);
        if (!['pending', 'processing'].includes(String(result.job.status))) break;
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      }
      await loadPersistentState();
    } finally { running.current = false; setProcessing(false); }
  }

  function start() {
    if (!preview?.success || !preview.preview.eligible_count) return;
    if (!window.confirm(`Enviar convite para ${preview.preview.eligible_count} pessoas? Quem já possui conta ou não for elegível será ignorado.`)) return;
    startTransition(async () => {
      const result = await startImportAccountInviteJobAction(importBatchId);
      if (!result.success) { setMessage(result.message); return; }
      await run(result.jobId);
    });
  }

  function retry() {
    if (!job?.id) return;
    startTransition(async () => {
      const result = await retryImportAccountInviteJobFailuresAction(String(job.id));
      if (!result.success) { setMessage(result.message); return; }
      await run(String(job.id));
    });
  }

  function loadFailures() {
    if (!job?.id) return;
    startTransition(async () => {
      const result = await listImportAccountInviteJobFailuresAction(String(job.id));
      if (!result.success) { setMessage(result.message); return; }
      setFailures(result.failures as Array<Record<string, unknown>>);
    });
  }

  const p = preview?.success ? preview.preview : null;
  const canStart = Boolean(p?.eligible_count) && (!job || !['pending', 'processing'].includes(String(job.status)));
  return (
    <article className="rounded-3xl border border-cyan-500/30 bg-cyan-500/10 p-5">
      <h2 className="text-xl font-semibold text-cyan-50">Gerenciar convites</h2>
      <p className="mt-1 text-sm text-cyan-100/80">Convites para criação de conta desta importação. O estado fica persistido no lote: recarregar ou reabrir a página não esconde este painel.</p>
      <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <p>Sem convite: {counts.withoutInvite}</p>
        <p>Convite pendente: {counts.pendingInvite}</p>
        <p>Ativados / claimed: {counts.claimed}</p>
        <p>Expirados: {counts.expiredInvite}</p>
        <p>Falharam no envio: {counts.failed}</p>
        <p>Pessoas do lote: {counts.total || importedCount}</p>
      </div>
      <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <p>Elegíveis agora: {p?.eligible_count ?? '—'}</p>
        <p>Já possuem conta: {p?.already_linked_count ?? '—'}</p>
        <p>Sem e-mail/e-mail inválido: {p?.invalid_email_count ?? '—'}</p>
        <p>Já convidados recentemente: {p?.recently_invited_count ?? '—'}</p>
        <p>Outros impedimentos: {p?.other_skipped_count ?? '—'}</p>
      </div>
      {job ? <div className="mt-4 rounded-xl bg-slate-950/60 p-3 text-sm"><p className="font-semibold">{['completed','completed_with_failures'].includes(String(job.status)) ? 'Último envio concluído' : 'Enviando convites'}</p><p>{job.processed_count} / {job.total_count} processados</p><p>{job.sent_count} enviados · {job.skipped_count} ignorados · {job.failed_count} falharam</p></div> : <p className="mt-4 text-sm text-cyan-100/70">Nenhum envio em lote foi iniciado ainda para esta importação.</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {canStart ? <button type="button" onClick={start} disabled={pending || !p?.eligible_count} className="h-10 rounded-xl bg-cyan-400 px-4 font-semibold text-cyan-950 disabled:opacity-50">{pending ? 'Iniciando...' : job ? 'Enviar convites restantes' : 'Enviar convites'}</button> : null}
        {job && ['pending','processing'].includes(String(job.status)) && !processing ? <button type="button" onClick={() => void run(String(job.id))} className="h-10 rounded-xl bg-cyan-400 px-4 font-semibold text-cyan-950">Continuar processamento</button> : null}
        {job && Number(job.failed_count) > 0 ? <button type="button" onClick={retry} disabled={pending} className="h-10 rounded-xl border border-amber-400/50 px-4 text-amber-100">Tentar novamente falhas</button> : null}
        {job && Number(job.failed_count) > 0 ? <button type="button" onClick={loadFailures} disabled={pending} className="h-10 rounded-xl border border-slate-600 px-4">Ver falhas</button> : null}
      </div>
      {failures.length ? <div className="mt-3 rounded-xl bg-slate-950/60 p-3 text-xs"><p className="mb-2 font-semibold">Falhas para revisão</p>{failures.map((failure) => <p key={String(failure.id)} className="mt-1">Tentativas: {String(failure.attempt_count)} · Motivo: {String(failure.error_code ?? 'Falha no envio')}</p>)}</div> : null}
      <p className="mt-4 text-sm text-cyan-100/80">Para reenviar o convite de uma pessoa específica, abra a ficha no cadastro — o botão Reenviar convite usa o mesmo fluxo Auth, sem expor token.</p>
      <Link href={`/cadastros?import_batch_id=${encodeURIComponent(importBatchId)}`} className="mt-2 inline-flex h-10 items-center rounded-xl border border-cyan-400/40 px-4 text-sm text-cyan-50">Abrir pessoas deste lote</Link>
      {message ? <p className="mt-3 text-sm text-rose-200">{message}</p> : null}
    </article>
  );
}
