"use client";

import { useMemo, useState, useTransition } from "react";
import { AdminEmptyState, AdminFilterBar, AdminSection, AdminStatCard, ReportDataTable } from "@/components/admin";
import { REPORT_CATEGORY_LABELS, type ReportCategory, type ReportDefinition } from "@/lib/reports/catalog";
import type { ReportResult } from "@/lib/reports/types";
import { getReportPreviewAction } from "./actions";

type Option = { id: string; name: string };

const inputClass = "h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm";

const DIACRITICS_PATTERN = new RegExp("[\\u0300-\\u036f]", "g");

function normalizeSearch(value: string) {
  return value.normalize("NFD").replace(DIACRITICS_PATTERN, "").toLowerCase();
}

export function ReportsExplorer({ catalog, events }: { catalog: ReportDefinition[]; events: Option[] }) {
  const [reportId, setReportId] = useState("");
  const [eventId, setEventId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ReportResult | null>(null);
  const [quickSearch, setQuickSearch] = useState("");

  const grouped = useMemo(() => {
    const map = new Map<ReportCategory, ReportDefinition[]>();
    for (const report of catalog) {
      map.set(report.category, [...(map.get(report.category) ?? []), report]);
    }
    return map;
  }, [catalog]);

  const selectedReport = catalog.find((report) => report.id === reportId) ?? null;

  function selectReport(nextId: string) {
    setReportId(nextId);
    setEventId("");
    setDateFrom("");
    setDateTo("");
    setResult(null);
    setQuickSearch("");
  }

  function generatePreview() {
    if (!selectedReport) return;
    setResult(null);
    setQuickSearch("");
    startTransition(async () => {
      const response = await getReportPreviewAction(selectedReport.id, {
        eventId: eventId || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
      });
      setResult(response);
    });
  }

  // Filtro rapido client-side sobre as linhas ja carregadas -- sem round-trip
  // ao servidor. Cobre "ação, operador, titular, ingresso, camiseta" num so
  // campo de texto: todas essas informacoes ja chegam como colunas de texto
  // no resultado, entao um free-text search cobre o pedido de "busca rapida
  // no dia do evento" sem precisar de um filtro dedicado por coluna.
  const normalizedQuickSearch = normalizeSearch(quickSearch.trim());
  const filteredRows = useMemo(() => {
    if (!result?.success) return [];
    if (!normalizedQuickSearch) return result.rows;
    return result.rows.filter((row) =>
      Object.values(row).some((value) => value !== null && normalizeSearch(String(value)).includes(normalizedQuickSearch)),
    );
  }, [result, normalizedQuickSearch]);

  const canGenerate = Boolean(selectedReport) && (selectedReport?.needsEvent !== "required" || Boolean(eventId));
  const exportParams = new URLSearchParams();
  if (eventId) exportParams.set("eventId", eventId);
  if (dateFrom) exportParams.set("dateFrom", dateFrom);
  if (dateTo) exportParams.set("dateTo", dateTo);
  if (quickSearch.trim()) exportParams.set("q", quickSearch.trim());
  const exportQuery = exportParams.toString();
  const canExport = Boolean(result?.success);

  if (catalog.length === 0) {
    return <AdminEmptyState title="Nenhum relatório disponível" description="Sua função não tem acesso a nenhum relatório no momento." />;
  }

  return (
    <div className="space-y-6">
      <AdminSection title="Escolha o relatório">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            <span className="text-slate-300">Relatório</span>
            <select value={reportId} onChange={(event) => selectReport(event.target.value)} className={`w-full ${inputClass}`}>
              <option value="">Selecione um relatório</option>
              {Array.from(grouped, ([category, reports]) => (
                <optgroup key={category} label={REPORT_CATEGORY_LABELS[category]}>
                  {reports.map((report) => (
                    <option key={report.id} value={report.id}>
                      {report.label} — {report.kind === "simplificado" ? "Simplificado" : "Detalhado"}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {selectedReport ? (
            <div className="flex items-end">
              <p className="text-sm text-slate-400">{selectedReport.description}</p>
            </div>
          ) : null}
        </div>

        {selectedReport ? (
          <AdminFilterBar>
            <div className="flex flex-wrap items-end gap-3">
              {selectedReport.needsEvent !== "none" ? (
                <label className="space-y-1 text-sm">
                  <span className="text-slate-300">Evento{selectedReport.needsEvent === "required" ? " (obrigatório)" : " (opcional)"}</span>
                  <select value={eventId} onChange={(event) => setEventId(event.target.value)} className={inputClass}>
                    <option value="">{selectedReport.needsEvent === "required" ? "Selecione" : "Todos os eventos"}</option>
                    {events.map((event) => (
                      <option key={event.id} value={event.id}>{event.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {selectedReport.needsDateRange ? (
                <>
                  <label className="space-y-1 text-sm">
                    <span className="text-slate-300">De</span>
                    <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className={inputClass} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-slate-300">Até</span>
                    <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className={inputClass} />
                  </label>
                </>
              ) : null}
              <button
                type="button"
                onClick={generatePreview}
                disabled={!canGenerate || pending}
                className="h-10 rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-emerald-950 disabled:opacity-50"
              >
                {pending ? "Gerando..." : "Gerar prévia"}
              </button>
              {canExport ? (
                <>
                  <a
                    href={`/api/relatorios/${selectedReport.id}/pdf${exportQuery ? `?${exportQuery}` : ""}`}
                    className="inline-flex h-10 items-center rounded-xl border border-slate-700 px-4 text-sm text-slate-200 hover:border-slate-500"
                  >
                    Exportar PDF
                  </a>
                  <a
                    href={`/api/relatorios/${selectedReport.id}/xlsx${exportQuery ? `?${exportQuery}` : ""}`}
                    className="inline-flex h-10 items-center rounded-xl border border-slate-700 px-4 text-sm text-slate-200 hover:border-slate-500"
                  >
                    Exportar Excel
                  </a>
                  <a
                    href={`/api/relatorios/${selectedReport.id}/csv${exportQuery ? `?${exportQuery}` : ""}`}
                    className="inline-flex h-10 items-center rounded-xl border border-slate-700 px-4 text-sm text-slate-200 hover:border-slate-500"
                  >
                    Exportar CSV
                  </a>
                </>
              ) : null}
            </div>
          </AdminFilterBar>
        ) : null}
      </AdminSection>

      {result && !result.success ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{result.message}</div>
      ) : null}

      {result && result.success ? (
        <AdminSection title={result.title} description={result.subtitle}>
          <div className="space-y-4">
            {result.notice ? (
              <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                {result.notice}
              </div>
            ) : null}
            {result.summaryCards.length > 0 ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {result.summaryCards.map((card) => (
                  <AdminStatCard key={card.label} label={card.label} value={card.value} />
                ))}
              </div>
            ) : null}
            <label className="block space-y-1 text-sm">
              <span className="text-slate-300">Busca rápida (filtra todas as colunas, inclusive na exportação)</span>
              <input
                value={quickSearch}
                onChange={(event) => setQuickSearch(event.target.value)}
                placeholder="Nome, ação, operador, ingresso, camiseta..."
                className={`w-full max-w-md ${inputClass}`}
              />
            </label>
            {quickSearch.trim() ? (
              <p className="text-xs text-slate-400">{filteredRows.length} de {result.rows.length} linha(s) exibida(s)</p>
            ) : null}
            <ReportDataTable columns={result.columns} rows={filteredRows} />
          </div>
        </AdminSection>
      ) : null}
    </div>
  );
}
