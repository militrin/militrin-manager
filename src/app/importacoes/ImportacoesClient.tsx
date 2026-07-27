'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  executeImportBatchAction,
  exportImportErrorsCsvAction,
  getImportBatchDetailsAction,
  parseImportFileAction,
  setImportRowResolutionAction,
} from './actions';
import { CANONICAL_FIELDS, type CanonicalField } from '@/lib/imports/columns';

type EventOption = {
  id: string;
  name: string;
  year: number | null;
};

type BatchRow = {
  id: string;
  row_number: number;
  status: string;
  resolution: string;
  error_message: string | null;
  matched_participant_id: string | null;
  matched_user_id: string | null;
  full_name: string;
  cpf_masked: string;
  email: string;
};

type ImportSummary = {
  totalRows: number;
  readyRows: number;
  duplicateRows: number;
  reviewRows: number;
  errorRows: number;
};

export function ImportacoesClient({ events }: { events: EventOption[] }) {
  const [isPending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [importType, setImportType] = useState<'historical_participations' | 'current_event_registrations'>('historical_participations');
  const [eventId, setEventId] = useState('');
  const [eventYear, setEventYear] = useState(String(new Date().getFullYear()));
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [report, setReport] = useState<Record<string, number> | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<CanonicalField, string>>>({});

  const readyCount = useMemo(() => rows.filter((row) => row.status === 'ready' || (row.status === 'review_required' && ['link_existing', 'create_new'].includes(row.resolution))).length, [rows]);

  function refreshBatch(targetBatchId: string) {
    startTransition(async () => {
      const details = await getImportBatchDetailsAction(targetBatchId);
      if (!details.success) {
        setMessage(details.message);
        return;
      }

      setRows(details.rows as BatchRow[]);
    });
  }

  function handleParse(customMapping?: Partial<Record<CanonicalField, string>>) {
    if (!file) {
      setMessage('Selecione um arquivo CSV ou XLSX.');
      return;
    }

    const formData = new FormData();
    formData.set('file', file);
    formData.set('import_type', importType);
    formData.set('event_id', eventId);
    formData.set('event_year', eventYear);
    if (customMapping) {
      formData.set('mapping_json', JSON.stringify(customMapping));
    }

    setMessage(null);
    setReport(null);

    startTransition(async () => {
      const result = await parseImportFileAction(formData);
      if (!result.success) {
        setMessage(result.message);
        return;
      }

      setBatchId(result.batchId);
      setHeaders(result.headers ?? []);
      setMapping(result.mapping ?? {});
      setSummary(result.summary);
      setRows((result.preview ?? []).map((row) => ({
        id: `preview-${row.row_number}`,
        row_number: row.row_number,
        status: row.status,
        resolution: row.resolution,
        error_message: row.message ?? null,
        matched_participant_id: null,
        matched_user_id: null,
        full_name: row.full_name,
        cpf_masked: row.cpf_masked,
        email: row.email,
      })));
      setMessage('Arquivo processado. Revise as linhas e confirme a importacao.');
      refreshBatch(result.batchId);
    });
  }

  function applyMapping() {
    handleParse(mapping);
  }

  function handleProcessClick() {
    handleParse();
  }

  function setResolution(rowId: string, resolution: 'pending' | 'link_existing' | 'create_new' | 'ignore' | 'mark_duplicate') {
    if (!batchId) return;

    startTransition(async () => {
      const result = await setImportRowResolutionAction({ batchId, rowId, resolution });
      if (!result.success) {
        setMessage(result.message);
        return;
      }

      refreshBatch(batchId);
    });
  }

  function executeImport() {
    if (!batchId) return;

    setMessage(null);
    startTransition(async () => {
      const result = await executeImportBatchAction(batchId);
      if (!result.success) {
        setMessage(result.message);
        return;
      }

      setReport(result.report);
      setMessage('Importacao concluida.');
      refreshBatch(batchId);
    });
  }

  function downloadErrors() {
    if (!batchId) return;

    startTransition(async () => {
      const result = await exportImportErrorsCsvAction(batchId);
      if (!result.success) {
        setMessage(result.message);
        return;
      }

      const blob = new Blob([result.content], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.fileName;
      link.click();
      URL.revokeObjectURL(url);
    });
  }

  return (
    <section className="space-y-5">
      <article className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
        <h2 className="text-xl font-semibold text-white">1) Enviar arquivo</h2>
        <p className="mt-1 text-sm text-slate-300">Suporte para CSV e XLSX. O sistema reconhece colunas conhecidas e aceita dados incompletos.</p>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="space-y-1 text-sm text-slate-300">
            <span>Tipo de importação</span>
            <select value={importType} onChange={(event) => setImportType(event.target.value as 'historical_participations' | 'current_event_registrations')} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3">
              <option value="historical_participations">Histórico de participações</option>
              <option value="current_event_registrations">Inscritos do evento atual</option>
            </select>
          </label>

          <label className="space-y-1 text-sm text-slate-300">
            <span>Evento</span>
            <select value={eventId} onChange={(event) => setEventId(event.target.value)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3">
              <option value="">Selecionar evento</option>
              {events.map((event) => (
                <option key={event.id} value={event.id}>{event.name} {event.year ? `(${event.year})` : ''}</option>
              ))}
            </select>
          </label>

          <label className="space-y-1 text-sm text-slate-300">
            <span>Ano do evento</span>
            <input value={eventYear} onChange={(event) => setEventYear(event.target.value)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
          </label>

          <label className="space-y-1 text-sm text-slate-300">
            <span>Arquivo</span>
            <input type="file" accept=".csv,.xlsx,.xls" onChange={(event) => setFile(event.target.files?.[0] ?? null)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
          </label>
        </div>

        <button type="button" onClick={handleProcessClick} disabled={isPending} className="mt-4 h-11 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 disabled:opacity-60">
          {isPending ? 'Processando...' : '2) Processar e validar'}
        </button>
      </article>

      {headers.length ? (
        <article className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
          <h2 className="text-xl font-semibold text-white">3) Mapear colunas</h2>
          <p className="mt-1 text-sm text-slate-300">Confirme o mapeamento antes de validar e importar.</p>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {CANONICAL_FIELDS.map((field) => (
              <label key={field} className="space-y-1 text-sm text-slate-300">
                <span>{field}</span>
                <select
                  value={mapping[field] ?? ''}
                  onChange={(event) => setMapping((prev) => ({ ...prev, [field]: event.target.value || undefined }))}
                  className="h-10 w-full rounded-xl border border-slate-700 bg-slate-950 px-3"
                >
                  <option value="">Nao mapear</option>
                  {headers.map((header) => (
                    <option key={header} value={header}>{header}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <button type="button" onClick={applyMapping} disabled={isPending} className="mt-4 h-11 rounded-xl border border-slate-700 px-5 text-sm text-slate-100 disabled:opacity-60">
            {isPending ? 'Aplicando...' : '4) Aplicar mapeamento e revalidar'}
          </button>
        </article>
      ) : null}

      {summary ? (
        <article className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
          <h2 className="text-xl font-semibold text-white">5) Prévia e validação</h2>
          <div className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-2 lg:grid-cols-5">
            <p>Linhas: {summary.totalRows}</p>
            <p>Prontas: {summary.readyRows}</p>
            <p>Duplicadas: {summary.duplicateRows}</p>
            <p>Revisão: {summary.reviewRows}</p>
            <p>Erros: {summary.errorRows}</p>
          </div>

          <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800">
            <table className="min-w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-950/80 text-slate-400">
                <tr>
                  <th className="px-3 py-2">Linha</th>
                  <th className="px-3 py-2">Nome</th>
                  <th className="px-3 py-2">CPF</th>
                  <th className="px-3 py-2">E-mail</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Ação</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-slate-800">
                    <td className="px-3 py-2">{row.row_number}</td>
                    <td className="px-3 py-2">{row.full_name}</td>
                    <td className="px-3 py-2">{row.cpf_masked}</td>
                    <td className="px-3 py-2">{row.email || '-'}</td>
                    <td className="px-3 py-2">{row.status}</td>
                    <td className="px-3 py-2">
                      {batchId && (row.status === 'review_required' || row.status === 'duplicate') ? (
                        <select
                          value={row.resolution}
                          onChange={(event) => setResolution(row.id, event.target.value as 'pending' | 'link_existing' | 'create_new' | 'ignore' | 'mark_duplicate')}
                          className="h-8 rounded-lg border border-slate-700 bg-slate-950 px-2"
                        >
                          <option value="pending">Pendente</option>
                          <option value="link_existing">Vincular existente</option>
                          <option value="create_new">Criar novo</option>
                          <option value="ignore">Ignorar</option>
                          <option value="mark_duplicate">Marcar duplicado</option>
                        </select>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                      {row.error_message ? <p className="mt-1 text-[11px] text-amber-300">{row.error_message}</p> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" onClick={executeImport} disabled={isPending || !batchId} className="h-11 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 disabled:opacity-60">
              {isPending ? 'Importando...' : `7) Confirmar importação (${readyCount} prontas)`}
            </button>
            <button type="button" onClick={downloadErrors} disabled={isPending || !batchId} className="h-11 rounded-xl border border-slate-700 px-5 text-sm text-slate-200 disabled:opacity-60">
              Baixar CSV de erros
            </button>
          </div>
        </article>
      ) : null}

      {report ? (
        <article className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
          <h2 className="text-xl font-semibold text-white">Relatório final</h2>
          <div className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-2 lg:grid-cols-4">
            <p>Processadas: {report.processed}</p>
            <p>Importadas: {report.imported}</p>
            <p>Atualizadas: {report.updated}</p>
            <p>Duplicadas: {report.duplicated}</p>
            <p>Aguardando revisão: {report.reviewRequired}</p>
            <p>Erros: {report.errors}</p>
            <p>Contas criadas: {report.accountsCreated}</p>
            <p>Ativações enviadas: {report.activationsSent}</p>
            <p>Tickets gerados: {report.ticketsGenerated}</p>
            <p>QR Codes gerados: {report.qrCodesGenerated}</p>
          </div>
        </article>
      ) : null}

      {message ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3 text-sm text-slate-200">{message}</p>
      ) : null}
    </section>
  );
}
