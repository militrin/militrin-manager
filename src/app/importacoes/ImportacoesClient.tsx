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
import { importRowHasExistingCpfIdentity, type ImportIdentityMatchDetails } from '@/lib/imports/identity-review';
import {
  importBatchOperationalLabel,
  isImportRowReadyToImport,
  resolveImportBatchOperationalState,
} from '@/lib/imports/batch-operational-state';

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
  identity_match_details?: ImportIdentityMatchDetails;
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

const inFlightImportExecutions = new Set<string>();

const STATUS_LABELS: Record<string, string> = {
  ready: 'Pronto',
  data_pending: 'Pendente de dados',
  duplicate: 'Duplicado',
  review_required: 'Pendente de revisão',
  error: 'Erro impeditivo',
  imported: 'Importado',
  skipped: 'Ignorado',
};

type OpenedBatch = {
  id: string;
  status: string;
  import_type: string;
  imported_rows: number | null;
  file_name: string | null;
  event_id?: string | null;
};

export function ImportacoesClient({ events, importOptions, canConfirmPayment = false, canManageInvites = false, initialBatchId }: { events: EventOption[]; importOptions: ImportOptions; canConfirmPayment?: boolean; canManageInvites?: boolean; initialBatchId?: string }) {
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
  const [openedBatch, setOpenedBatch] = useState<OpenedBatch | null>(null);
  const [executeStarted, setExecuteStarted] = useState(false);
  const eventCategories = importOptions.categories.filter((item) => item.event_id === eventId);
  const eventBatches = importOptions.batches.filter((item) => item.event_id === eventId);
  const compatibleCategories = defaultBatchId ? eventCategories.filter((item) => importOptions.prices.some((price) => price.batch_id === defaultBatchId && price.ticket_category_id === item.id)) : eventCategories;
  const compatibleBatches = defaultCategoryId ? eventBatches.filter((item) => importOptions.prices.some((price) => price.ticket_category_id === defaultCategoryId && price.batch_id === item.id)) : eventBatches;
  const operationalState = useMemo(
    () => resolveImportBatchOperationalState({
      status: openedBatch?.status,
      importedRows: openedBatch?.imported_rows,
      rows: rows.map((row) => ({ status: row.status, resolution: row.resolution })),
    }),
    [openedBatch?.status, openedBatch?.imported_rows, rows],
  );
  const showInvitePanel = Boolean(canManageInvites && batchId && openedBatch?.status === 'completed');
  const importableCount = useMemo(
    () => rows.filter((row) => isImportRowReadyToImport(row.status, row.resolution)).length,
    [rows],
  );
  const blockingPaymentCount = useMemo(() => rows.filter((row) => row.data_issues.some((issue) => issue.blocks_payment)).length, [rows]);
  const showExecuteButton = (operationalState.canExecute || executeStarted) && !operationalState.showAlreadyImportedMessage;

  function applyBatchDetails(details: Extract<Awaited<ReturnType<typeof getImportBatchDetailsAction>>, { success: true }>) {
    setRows(details.rows as BatchRow[]);
    setSummary(details.summary);
    const batch = details.batch as OpenedBatch;
    setOpenedBatch({
      id: String(batch.id),
      status: String(batch.status),
      import_type: String(batch.import_type),
      imported_rows: batch.imported_rows == null ? null : Number(batch.imported_rows),
      file_name: batch.file_name ? String(batch.file_name) : null,
      event_id: (details.batch as { event_id?: string | null }).event_id ?? null,
    });
    if (batch.import_type === 'historical_participations' || batch.import_type === 'current_event_registrations') {
      setImportType(batch.import_type);
    }
    const eventIdFromBatch = (details.batch as { event_id?: string | null }).event_id;
    if (eventIdFromBatch) setEventId(String(eventIdFromBatch));
    if (!details.operationalState.commerciallyCompleted) {
      setExecuteStarted(false);
      if (batch.id) inFlightImportExecutions.delete(String(batch.id));
    }
  }

  function refreshBatch(targetBatchId: string) {
    startTransition(async () => {
      const details = await getImportBatchDetailsAction(targetBatchId);
      if (!details.success) {
        setMessage(details.message);
        return;
      }

      applyBatchDetails(details);
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
      applyBatchDetails(details);
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
    setOpenedBatch(null);
    setExecuteStarted(false);
    if (batchId) inFlightImportExecutions.delete(batchId);

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
    if (!batchId || !operationalState.canExecute || executeStarted || inFlightImportExecutions.has(batchId)) return;

    inFlightImportExecutions.add(batchId);
    setExecuteStarted(true);
    setMessage(null);
    startTransition(async () => {
      const result = await executeImportBatchAction(
        batchId,
        paymentMode,
        paymentReason || undefined,
      );
      if (!result.success) {
        inFlightImportExecutions.delete(batchId);
        setExecuteStarted(false);
        setMessage(result.message);
        return;
      }

      setReport(result.report);
      setOpenedBatch((current) => current && current.id === batchId
        ? {
          ...current,
          status: result.report.reviewRequired > 0 ? 'ready_for_review' : 'completed',
          imported_rows: Number(result.report.imported ?? current.imported_rows ?? 0),
        }
        : current);
      setMessage(result.report.reviewRequired > 0
        ? `Importação processada com ${result.report.reviewRequired} linha(s) aguardando revisão.`
        : (result.report.awaitingData ?? 0) > 0 ? 'Importação concluída com pendências.' : 'Importação concluída com sucesso.');
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
      {openedBatch && batchId ? (
        <article className="rounded-3xl border border-cyan-500/30 bg-cyan-500/10 p-5">
          <h2 className="text-xl font-semibold text-cyan-50">Lote reaberto</h2>
          <p className="mt-1 text-sm font-medium text-cyan-50">{importBatchOperationalLabel(operationalState)}</p>
          <p className="mt-1 text-sm text-cyan-100/80">{openedBatch.file_name || 'Importação'} · status {openedBatch.status} · {openedBatch.imported_rows ?? 0} importado(s).</p>
          <p className="mt-1 text-sm text-cyan-100/80">
            {operationalState.commerciallyCompleted
              ? 'Recarregar esta página mantém o lote e o painel de convites.'
              : 'O arquivo já foi validado e gravado. Recarregar a página não perde o caminho de importação.'}
          </p>
        </article>
      ) : null}
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
          <div className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-2 lg:grid-cols-6">
            <p>Linhas: {summary.totalRows}</p>
            <p>Prontas: {summary.readyRows}</p>
            <p>Pendentes: {summary.pendingRows}</p>
            <p>Duplicadas: {summary.duplicateRows}</p>
            <p>Revisões neste lote: {summary.reviewRows}</p>
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
                        (() => {
                          const hasExistingCpf = importRowHasExistingCpfIdentity(row.identity_match_details, row.cpf_masked);
                          return (
                            <div className="space-y-1">
                              <select
                                value={row.resolution}
                                onChange={(event) => setResolution(row.id, event.target.value as 'pending' | 'link_existing' | 'create_new' | 'ignore' | 'mark_duplicate')}
                                className="h-8 rounded-lg border border-slate-700 bg-slate-950 px-2"
                              >
                                <option value="pending">Pendente</option>
                                <option value="link_existing">Vincular existente</option>
                                {hasExistingCpf ? null : <option value="create_new">Criar novo</option>}
                                <option value="ignore">Ignorar</option>
                                <option value="mark_duplicate">Marcar duplicado</option>
                              </select>
                              {hasExistingCpf ? <p className="text-[11px] text-amber-300">Este CPF já identifica um cadastro. Não é possível criar outra Pessoa: vincule o existente, revise os dados ou ignore a linha.</p> : null}
                            </div>
                          );
                        })()
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
            {importType === 'current_event_registrations' && showExecuteButton && (
              <div className="w-full rounded-2xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
                <p className="text-sm font-medium text-slate-200">6) Tratamento dos pagamentos importados</p>
                <p className="text-xs text-slate-400">Escolha o efeito <strong>antes</strong> de confirmar. O padrão continua sendo importar como pendente, sem emitir ingresso.</p>
                <div className="grid gap-3 lg:grid-cols-2">
                  <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 ${paymentMode === 'pending' ? 'border-slate-500 bg-slate-900' : 'border-slate-800'}`}>
                    <input
                      type="radio" name="paymentMode" value="pending"
                      checked={paymentMode === 'pending'}
                      onChange={() => setPaymentMode('pending')}
                      className="mt-1 accent-emerald-500"
                    />
                    <span>
                      <span className="block text-sm font-medium text-slate-100">Manter como pendente</span>
                      <span className="mt-1 block text-xs text-slate-400">Importar como pendente, sem emitir ingresso. Cria cadastro e pedido/pagamento pendente. Em Minha Conta a pessoa vê o cadastro, mas <strong>não recebe ingresso nem QR</strong> até um administrador com `finance.confirm_payment` confirmar o pagamento.</span>
                    </span>
                  </label>
                  {canConfirmPayment ? (
                    <label className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 ${paymentMode === 'confirm_all' ? 'border-emerald-400 bg-emerald-500/10' : 'border-emerald-700/40 bg-emerald-950/20'}`}>
                      <input
                        type="radio" name="paymentMode" value="confirm_all"
                        checked={paymentMode === 'confirm_all'}
                        onChange={() => setPaymentMode('confirm_all')}
                        className="mt-1 accent-emerald-500"
                      />
                      <span>
                        <span className="block text-sm font-semibold text-emerald-200">Confirmar todos como pagos e emitir ingressos</span>
                        <span className="mt-1 block text-xs text-emerald-100/80">Equivale a <strong>confirm_all</strong>: confirma os pagamentos aptos agora e emite ingresso/QR imediatamente. Em Minha Conta o ingresso e o QR passam a aparecer. Exige permissão financeira `finance.confirm_payment`.</span>
                      </span>
                    </label>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-700 p-4 text-xs text-slate-400">A opção de confirmar pagamentos e emitir ingressos agora (`confirm_all`) só aparece para quem tem `finance.confirm_payment`.</div>
                  )}
                </div>
                {paymentMode === 'pending' ? (
                  <p className="text-xs text-amber-300">Esta importação <strong>não emitirá ingresso</strong>. Depois do primeiro acesso, Minha Conta pode ficar sem QR até o pagamento ser confirmado.</p>
                ) : null}
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
            {operationalState.showAlreadyImportedMessage ? (
              <p className="rounded-xl border border-slate-700 px-4 py-3 text-sm text-slate-300">Este lote já foi importado ({openedBatch?.status}). Use as ações pós-importação abaixo; não é necessário importar de novo.</p>
            ) : showExecuteButton ? (
              <button type="button" onClick={executeImport} disabled={isPending || !batchId || executeStarted} className="h-11 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 disabled:opacity-60">
                {isPending || executeStarted ? 'Importando...' : summary.pendingRows > 0
                  ? `7) Importar ${importableCount} cadastros (${summary.pendingRows} com pendências)`
                  : `7) Confirmar importação de ${importableCount} participações`}
              </button>
            ) : operationalState.showIdentityReviewBanner ? (
              <p className="rounded-xl border border-amber-700 px-4 py-3 text-sm text-amber-100">Há {operationalState.unresolvedReviewCount} revisão(ões) de identidade neste lote. A importação das linhas pendentes fica disponível depois da revisão.</p>
            ) : (
              <p className="rounded-xl border border-slate-700 px-4 py-3 text-sm text-slate-300">Não há linhas prontas para importar neste lote.</p>
            )}
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
          <div className="mt-5 flex flex-wrap gap-3">
            {report.reviewRequired > 0 && batchId ? <Link href={`/importacoes/revisoes?batchId=${encodeURIComponent(batchId)}`} className="inline-flex rounded-xl bg-amber-400 px-5 py-3 font-semibold text-amber-950">Revisar pendências</Link> : null}
            {(report.awaitingData ?? 0) > 0 && batchId ? <Link href={`/cadastros?import_batch_id=${encodeURIComponent(batchId)}`} className="inline-flex rounded-xl border border-amber-500 px-5 py-3 font-semibold text-amber-200">Ver pessoas deste lote</Link> : null}
          </div>
        </article>
      ) : null}

      {report && (report.awaitingData ?? 0) > 0 && batchId ? (
        <p className="text-sm text-slate-400">Pendências de dados (categoria, lote, CPF incompleto etc.) se resolvem na ficha de cada pessoa. A fila de identidade fica em Revisões pendentes.</p>
      ) : null}

      {operationalState.showIdentityReviewBanner && batchId ? (
        <article className="rounded-3xl border border-amber-500/30 bg-amber-500/10 p-5">
          <h2 className="text-xl font-semibold text-amber-50">Revisões de identidade pendentes deste lote</h2>
          <p className="mt-1 text-sm text-amber-100/80">{operationalState.unresolvedReviewCount} revisão(ões) neste lote. Este lote ainda não pode enviar convites. Conclua as revisões (vincular cadastro existente ou ignorar) e continue a importação.</p>
          <Link href={`/importacoes/revisoes?batchId=${encodeURIComponent(batchId)}`} className="mt-4 inline-flex rounded-xl bg-amber-400 px-5 py-3 font-semibold text-amber-950">Abrir revisões deste lote</Link>
        </article>
      ) : null}

      {showInvitePanel && batchId ? <ImportAccountInvites importBatchId={batchId} importedCount={Number(openedBatch?.imported_rows ?? report?.imported ?? 0)} /> : null}

      {message ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3 text-sm text-slate-200">{message}</p>
      ) : null}
    </section>
  );
}
