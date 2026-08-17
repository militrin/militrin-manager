'use client';

import { useState, useTransition } from 'react';
import { ImageIcon } from 'lucide-react';
import { SlideOverPanel } from '@/components/admin/SlideOverPanel';
import { MilitrinStatusBadge } from '@/components/militrin';
import { formatDateTimeBR } from '@/lib/utils/date';
import { getFeedbackDetailAction, listFeedbackForAdminAction, updateFeedbackStatusAction } from './actions';

export type AdminFeedbackRow = {
  feedback_id: string;
  type: string;
  message: string;
  status: string;
  page_path: string | null;
  has_screenshot: boolean;
  user_id: string;
  user_full_name: string | null;
  user_email: string | null;
  event_id: string | null;
  event_name: string | null;
  created_at: string;
};

type FeedbackDetail = {
  feedback_id: string;
  type: string;
  message: string;
  status: string;
  admin_notes: string | null;
  page_path: string | null;
  screenshot_path: string | null;
  screenshot_url: string | null;
  technical_context: Record<string, unknown> | null;
  event_id: string | null;
  event_name: string | null;
  user_id: string;
  user_full_name: string | null;
  user_email: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
};

const TYPE_LABELS: Record<string, string> = { problem: 'Problema', suggestion: 'Sugestão', question: 'Dúvida' };
const STATUS_BADGE: Record<string, { status: string; label: string }> = {
  new: { status: 'pending', label: 'Novo' },
  reviewing: { status: 'processing', label: 'Em análise' },
  resolved: { status: 'confirmed', label: 'Resolvido' },
  ignored: { status: 'cancelled', label: 'Ignorado' },
};
const STATUS_OPTIONS = [
  { value: 'new', label: 'Novo' },
  { value: 'reviewing', label: 'Em análise' },
  { value: 'resolved', label: 'Resolvido' },
  { value: 'ignored', label: 'Ignorado' },
];

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function FeedbackManager({ initialFeedback }: { initialFeedback: AdminFeedbackRow[] }) {
  const [feedback, setFeedback] = useState(initialFeedback);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusDraft, setStatusDraft] = useState('new');
  const [notesDraft, setNotesDraft] = useState('');

  function applyFilters() {
    startTransition(async () => {
      const result = await listFeedbackForAdminAction({
        status: statusFilter || null,
        type: typeFilter || null,
        from: fromFilter ? new Date(fromFilter).toISOString() : null,
        to: toFilter ? new Date(`${toFilter}T23:59:59`).toISOString() : null,
      });
      if (!result.success) {
        setMessage({ type: 'error', text: result.message ?? 'Falha ao filtrar.' });
        return;
      }
      setFeedback(result.feedback as AdminFeedbackRow[]);
    });
  }

  function openDetail(feedbackId: string) {
    setSelectedId(feedbackId);
    setDetail(null);
    setDetailLoading(true);
    startTransition(async () => {
      const result = await getFeedbackDetailAction(feedbackId);
      setDetailLoading(false);
      if (!result.success || !result.feedback) {
        setMessage({ type: 'error', text: result.message ?? 'Falha ao carregar feedback.' });
        setSelectedId(null);
        return;
      }
      const row = result.feedback as FeedbackDetail;
      setDetail(row);
      setStatusDraft(row.status);
      setNotesDraft(row.admin_notes ?? '');
    });
  }

  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
  }

  function saveStatus() {
    if (!selectedId) return;
    startTransition(async () => {
      const result = await updateFeedbackStatusAction({ feedbackId: selectedId, status: statusDraft, adminNotes: notesDraft.trim() || null });
      setMessage({ type: result.success ? 'success' : 'error', text: result.message ?? '' });
      if (result.success) {
        setFeedback((prev) => prev.map((row) => (row.feedback_id === selectedId ? { ...row, status: statusDraft } : row)));
        setDetail((prev) => (prev ? { ...prev, status: statusDraft, admin_notes: notesDraft.trim() || prev.admin_notes } : prev));
      }
    });
  }

  return (
    <div className="space-y-5">
      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
          {message.text}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Status</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm">
            <option value="">Todos</option>
            {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Tipo</span>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm">
            <option value="">Todos</option>
            {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">De</span>
          <input type="date" value={fromFilter} onChange={(event) => setFromFilter(event.target.value)} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm" />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Até</span>
          <input type="date" value={toFilter} onChange={(event) => setToFilter(event.target.value)} className="rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm" />
        </label>
        <button type="button" onClick={applyFilters} disabled={isPending} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 disabled:opacity-60">
          Filtrar
        </button>
      </div>

      <div className="space-y-2.5">
        {feedback.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">Nenhum feedback encontrado.</div>
        ) : (
          feedback.map((row) => {
            const badge = STATUS_BADGE[row.status] ?? { status: 'neutral', label: row.status };
            return (
              <button
                key={row.feedback_id}
                type="button"
                onClick={() => openDetail(row.feedback_id)}
                className="flex w-full flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-left transition hover:border-slate-600"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <MilitrinStatusBadge status={badge.status} label={badge.label} />
                    <span className="rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-0.5 text-[11px] font-medium text-slate-300">{TYPE_LABELS[row.type] ?? row.type}</span>
                    {row.has_screenshot ? <ImageIcon size={13} className="text-slate-500" aria-label="Possui imagem anexada" /> : null}
                  </div>
                  <p className="mt-1.5 truncate text-sm text-slate-200">{truncate(row.message, 90)}</p>
                  <p className="mt-1 truncate text-xs text-slate-500">
                    {row.user_full_name ?? row.user_email ?? 'Usuário'} · {row.page_path ?? 'página não identificada'}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-slate-500">{formatDateTimeBR(row.created_at, ' ')}</span>
              </button>
            );
          })
        )}
      </div>

      <SlideOverPanel open={selectedId !== null} title="Detalhe do feedback" onClose={closeDetail}>
        {detailLoading || !detail ? (
          <p className="text-sm text-slate-400">Carregando...</p>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <MilitrinStatusBadge status={(STATUS_BADGE[detail.status] ?? { status: 'neutral' }).status} label={(STATUS_BADGE[detail.status] ?? { label: detail.status }).label} />
              <span className="rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-0.5 text-[11px] font-medium text-slate-300">{TYPE_LABELS[detail.type] ?? detail.type}</span>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mensagem</p>
              <p className="mt-1 whitespace-pre-wrap text-slate-200">{detail.message}</p>
            </div>

            {detail.screenshot_url ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Imagem</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={detail.screenshot_url} alt="Screenshot enviado pelo usuário" className="mt-1 w-full rounded-xl border border-slate-700 object-contain" />
              </div>
            ) : null}

            <div className="grid gap-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-400">
              <p><span className="text-slate-500">Usuário:</span> {detail.user_full_name ?? 'Sem nome'} {detail.user_email ? `(${detail.user_email})` : ''}</p>
              <p><span className="text-slate-500">Página:</span> {detail.page_path ?? 'não identificada'}</p>
              {detail.event_name ? <p><span className="text-slate-500">Evento:</span> {detail.event_name}</p> : null}
              <p><span className="text-slate-500">Enviado em:</span> {formatDateTimeBR(detail.created_at, ' ')}</p>
              {detail.resolved_by_name ? <p><span className="text-slate-500">Resolvido por:</span> {detail.resolved_by_name}</p> : null}
            </div>

            {detail.technical_context && Object.keys(detail.technical_context).length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Contexto técnico</p>
                <pre className="mt-1 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-[11px] text-slate-400">
                  {JSON.stringify(detail.technical_context, null, 2)}
                </pre>
              </div>
            ) : null}

            <div className="space-y-3 border-t border-slate-800 pt-4">
              <label className="block space-y-1">
                <span className="text-xs text-slate-300">Status</span>
                <select value={statusDraft} onChange={(event) => setStatusDraft(event.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm">
                  {STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-300">Observação interna</span>
                <textarea
                  value={notesDraft}
                  onChange={(event) => setNotesDraft(event.target.value)}
                  rows={3}
                  className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm"
                  placeholder="Visível apenas para a equipe."
                />
              </label>
              <button type="button" onClick={saveStatus} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
                Salvar
              </button>
            </div>
          </div>
        )}
      </SlideOverPanel>
    </div>
  );
}
