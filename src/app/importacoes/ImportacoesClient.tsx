'use client';

import Link from 'next/link';
import { ImportAccountInvites } from './import-account-invites';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  executeImportBatchAction,
  exportImportErrorsCsvAction,
  getImportBatchDetailsAction,
  parseImportFileAction,
  setImportRowResolutionAction,
} from './actions';
import { CANONICAL_FIELDS, CANONICAL_FIELD_LABELS, type CanonicalField } from '@/lib/imports/columns';

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
  data_issues: Array<{ message?: string; blocks_payment?: boolean }>;
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
  pendingRows: number;
  errorRows: number;
};
type ImportOptions = { categories: Array<{ id: string; event_id: string; name: string }>; batches: Array<{ id: string; event_id: string; name: string }>; prices: Array<{ batch_id: string; ticket_category_id: string }> };

const STATUS_LABELS: Record<string, string> = {
  ready: 'Pronto',
  data_pending: 'Pendente de dados',
  duplicate: 'Duplicado',
  review_required: 'Pendente de revisão',
  error: 'Erro impeditivo',
  imported: 'Importado',
  skipped: 'Ignorado',
};

export function ImportacoesClient({ events, importOptions, canConfirmPayment = false, initialBatchId }: { events: EventOption[]; importOptions: ImportOptions; canConfirmPayment?: boolean; initialBatchId?: string }) {
  const [isPending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [importType, setImportType] = useState<'historical_participations' | 'current_event_registrations'>('historical_participations');
  const [eventId, setEventId] = useState('');
  const [historicalEventName, setHistoricalEventName] = useState('MILITRIN 2025');
  const [historicalEventYear, setHistoricalEventYear] = useState(String(new Date().getFullYear()));
  const [batchId, setBatchId] = useState<string | null>(initialBatchId ?? null);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [report, setReport] = useState<Record<string, number> | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<CanonicalField, string>>>({});
  const [paymentMode, setPaymentMode] = useState<'pending' | 'confirm_all'>('pending');
  const [paymentReason, setPaymentReason] = useState('');
  const [defaultCategoryId, setDefaultCategoryId] = useState('');
  const [defaultBatchId, setDefaultBatchId] = useState('');
  const eventCategories = importOptions.categories.filter((item) => item.event_id === eventId);
  const eventBatches = importOptions.batches.filter((item) => item.event_id === eventId);
  const compatibleCategories = defaultBatchId ? eventCategories.filter((item) => importOptions.prices.some((price) => price.batch_id === defaultBatchId && price.ticket_category_id === item.id)) : eventCategories;
  const compatibleBatches = defaultCategoryId ? eventBatches.filter((item) => importOptions.prices.some((price) => price.ticket_category_id === defaultCategoryId && price.batch_id === item.id)) : eventBatches;

  const importableCount = useMemo(() => rows.filter((row) => row.status === 'ready' || row.status === 'data_pending' || (row.status === 'review_required' && ['link_existing', 'create_new'].includes(row.resolution))).length, [rows]);
  const blockingPaymentCount = useMemo(() => rows.filter((row) => row.data_issues.some((issue) => issue.blocks_payment)).length, [rows]);

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

  useEffect(() => {
    if (!initialBatchId) return;
    startTransition(async () => {
      const details = await getImportBatchDetailsAction(initialBatchId);
      if (!details.success) {
        setMessage(details.message);
        return;
      }
      setRows(details.rows as BatchRow[]);
    });
  }, [initialBatchId]);

  function handleParse(customMapping?: Partial<Record<CanonicalField, string>>) {
    if (!file) {
      setMessage('Selecione um arquivo CSV ou XLSX.');
      return;
    }

    const formData = new FormData();
    formData.set('file', file);
    formData.set('import_type', importType);
    formData.set('event_id', eventId);
    formData.set('historical_event_name', historicalEventName);
    formData.set('historical_event_year', historicalEventYear);
    formData.set('default_category_id', defaultCategoryId);
    formData.set('default_batch_id', defaultBatchId);
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
        data_issues: row.data_issues ?? [],
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
      const result = await executeImportBatchAction(
        batchId,
        paymentMode,
        paymentReason || undefined,
      );
      if (!result.success) {
        setMessage(result.message);
        return;
      }

      setReport(result.report);
      setMessage((result.report.awaitingData ?? 0) > 0 ? 'Importação concluída com pendências.' : 'Importação concluída com sucesso.');
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
              <option value="current_event_registrations">Cadastros do evento selecionado</option>
            </select>
          </label>

          {importType === 'historical_participations' ? (
            <>
              <label className="space-y-1 text-sm text-slate-300 md:col-span-2 xl:col-span-2">
                <span>Nome do evento histórico</span>
                <input
                  value={historicalEventName}
                  onChange={(event) => setHistoricalEventName(event.target.value)}
                  className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 uppercase"
                  placeholder="MILITRIN 2025"
                />
              </label>

              <label className="space-y-1 text-sm text-slate-300">
                <span>Ano interno</span>
                <input value={historicalEventYear} onChange={(event) => setHistoricalEventYear(event.target.value)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
              </label>
            </>
          ) : (
            <>
              <label className="space-y-1 text-sm text-slate-300">
                <span>Evento</span>
                <select value={eventId} onChange={(event) => { setEventId(event.target.value); setDefaultCategoryId(''); setDefaultBatchId(''); }} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3">
                  <option value="">Selecionar evento</option>
                  {events.map((event) => (
                    <option key={event.id} value={event.id}>{event.name} {event.year ? `(${event.year})` : ''}</option>
                  ))}
                </select>
              </label>

              <label className="space-y-1 text-sm text-slate-300"><span>Categoria padrão</span><select value={defaultCategoryId} onChange={(event) => setDefaultCategoryId(event.target.value)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3"><option value="">Sem padrão</option>{compatibleCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label className="space-y-1 text-sm text-slate-300"><span>Lote padrão</span><select value={defaultBatchId} onChange={(event) => setDefaultBatchId(event.target.value)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3"><option value="">Sem padrão</option>{compatibleBatches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>

              <label className="space-y-1 text-sm text-slate-300">
                <span>Ano do evento</span>
                <input value={historicalEventYear} onChange={(event) => setHistoricalEventYear(event.target.value)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
              </label>
            </>
          )}

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
                <span>{CANONICAL_FIELD_LABELS[field]}</span>
                <select
                  value={mapping[field] ?? ''}
                  onChange={(event) => setMapping((prev) => ({ ...prev, [field]: event.target.value || undefined }))}
                  className="h-10 w-full rounded-xl border border-slate-700 bg-slate-950 px-3"
                >
                  <option value="">Não mapear</option>
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
          {importType === 'historical_participations' ? (
            <div className="mt-3 rounded-2xl border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-200">
              <p>Evento que será registrado: <strong>{historicalEventName}</strong></p>
              <p className="mt-1">Cadastros encontrados: <strong>{summary.totalRows}</strong></p>
              {rows.slice(0, 3).length > 0 ? (
                <p className="mt-1 text-slate-400">Exemplos: {rows.slice(0, 3).map((row) => row.full_name).join(', ')}</p>
              ) : null}
            </div>
          ) : null}
          <div className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-2 lg:grid-cols-5">
            <p>Linhas: {summary.totalRows}</p>
            <p>Prontas: {summary.readyRows}</p>
            <p>Pendentes: {summary.pendingRows}</p>
            <p>Duplicadas: {summary.duplicateRows}</p>
            <p>Erros impeditivos: {summary.errorRows}</p>
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
                    <td className="px-3 py-2">{STATUS_LABELS[row.status] ?? row.status}</td>
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
            {importType === 'current_event_registrations' && (
              <div className="w-full rounded-2xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
                <p className="text-sm font-medium text-slate-200">6) Tratamento dos pagamentos importados</p>
                <div className="flex flex-wrap gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio" name="paymentMode" value="pending"
                      checked={paymentMode === 'pending'}
                      onChange={() => setPaymentMode('pending')}
                      className="accent-emerald-500"
                    />
                    <span className="text-sm text-slate-300">Manter como pendente</span>
                  </label>
                  {canConfirmPayment && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio" name="paymentMode" value="confirm_all"
                        checked={paymentMode === 'confirm_all'}
                        onChange={() => setPaymentMode('confirm_all')}
                        className="accent-emerald-500"
                      />
                      <span className="text-sm text-emerald-300 font-medium">Confirmar todos como pagos e emitir ingressos</span>
                    </label>
                  )}
                </div>
                {paymentMode === 'confirm_all' && (
                  <div className="space-y-1">
                    {blockingPaymentCount > 0 ? (
                      <p className="text-sm font-medium text-amber-300">{blockingPaymentCount} cadastro(s) possuem pendências que impedem a confirmação do pagamento. Apenas os registros aptos serão confirmados.</p>
                    ) : null}
                    <label className="text-xs text-slate-500">Motivo (opcional — gerado automaticamente se em branco)</label>
                    <input
                      value={paymentReason}
                      onChange={(e) => setPaymentReason(e.target.value)}
                      placeholder={`Pagamento confirmado na importação`}
                      className="h-9 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                    />
                    <p className="text-xs text-amber-400">⚠ Cada pagamento válido será marcado como pago e o ingresso será emitido. A operação ficará registrada no histórico de auditoria.</p>
                  </div>
                )}
              </div>
            )}
            <button type="button" onClick={executeImport} disabled={isPending || !batchId} className="h-11 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 disabled:opacity-60">
              {isPending ? 'Importando...' : summary.pendingRows > 0
                ? `7) Importar ${importableCount} cadastros (${summary.pendingRows} com pendências)`
                : `7) Confirmar importação de ${importableCount} participações`}
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
          <div className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-3">
            <p className="font-medium text-emerald-200">{report.completedWithoutPending ?? report.imported} importados com sucesso</p>
            <p className="font-medium text-amber-200">{report.awaitingData ?? 0} com pendências</p>
            <p className="font-medium text-rose-200">{report.errors} erros</p>
          </div>
          <div className="mt-4 grid gap-2 text-sm text-slate-400 sm:grid-cols-2 lg:grid-cols-4">
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
            <p>Aguardando dados: {report.awaitingData ?? 0}</p>
            <p>Pagamentos confirmados: {report.paymentsConfirmed ?? 0}</p>
            <p>Pagamentos mantidos pendentes: {report.awaitingData ?? 0}</p>
          </div>
          {(report.awaitingData ?? 0) > 0 && batchId ? <Link href={`/cadastros?pending=yes&import_batch_id=${encodeURIComponent(batchId)}`} className="mt-5 inline-flex rounded-xl bg-amber-400 px-5 py-3 font-semibold text-amber-950">Resolver pendências</Link> : null}
        </article>
      ) : null}

      {report && batchId ? <ImportAccountInvites importBatchId={batchId} importedCount={report.imported} /> : null}

      {message ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3 text-sm text-slate-200">{message}</p>
      ) : null}
    </section>
  );
}
