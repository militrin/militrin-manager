"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardCheck,
  RefreshCw,
  Search,
  Shirt,
  ShoppingBag,
  SlidersHorizontal,
  Tag,
  Ticket,
  Undo2,
  UserRound,
} from "lucide-react";
import {
  AdminEmptyState,
  AdminFilterBar,
  AdminSection,
  SlideOverPanel,
} from "@/components/admin";
import { CATEGORY_LABELS, HISTORY_CATEGORIES, PAGE_SIZE } from "@/lib/operations/history/constants";
import {
  extraHistoryFilterCount,
  feedIconKind,
  feedMetaLine,
  feedParticipantLine,
  feedTone,
  formatFeedOccurredAt,
} from "@/lib/operations/history/presentation";
import type {
  HistoryPeriodPreset,
  OperationHistoryCategory,
  OperationHistoryItem,
  OperationHistoryResponse,
} from "@/lib/operations/history/types";
import { getOperationsHistoryAction } from "./actions";
import { getReportPreviewAction } from "@/app/relatorios/actions";
import type { ReportResult } from "@/lib/reports/types";

type EventOption = { id: string; name: string };
type FeedIconKind = ReturnType<typeof feedIconKind>;

const POLL_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 350;
const PERIOD_OPTIONS = [
  ["today", "Hoje"],
  ["7d", "7 dias"],
  ["30d", "30 dias"],
  ["custom", "Personalizado"],
] as const;
const inputClass = "h-11 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 lg:h-9";
const TONE_CLASS: Record<ReturnType<typeof feedTone>, string> = {
  success: "text-emerald-300",
  warning: "text-amber-300",
  danger: "text-rose-300",
  neutral: "text-slate-300",
};
const FEED_ICONS: Record<FeedIconKind, typeof Shirt> = {
  kit: Shirt,
  checkin: ClipboardCheck,
  wristband: Tag,
  holder: UserRound,
  ticket: Ticket,
  undo: Undo2,
  store: ShoppingBag,
};

function secondsAgoLabel(fromIso: string, nowMs: number) {
  const then = Date.parse(fromIso);
  if (!Number.isFinite(then)) return "Atualizado agora";
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 5) return "Atualizado agora";
  return `Atualizado há ${seconds} segundo${seconds === 1 ? "" : "s"}`;
}

function liveStatus(fromIso: string, nowMs: number) {
  const then = Date.parse(fromIso);
  if (!Number.isFinite(then)) return "Agora";
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (seconds < 5) return "Agora";
  return `há ${seconds}s`;
}

export function OperationsHistoryClient({
  events,
  initialEventId,
  initialResult,
}: {
  events: EventOption[];
  initialEventId: string;
  initialResult: OperationHistoryResponse;
}) {
  const [eventId, setEventId] = useState(initialEventId);
  const [period, setPeriod] = useState<HistoryPeriodPreset>(initialResult.success ? initialResult.period : "today");
  const [dateFrom, setDateFrom] = useState(initialResult.success ? initialResult.dateFrom : "");
  const [dateTo, setDateTo] = useState(initialResult.success ? initialResult.dateTo : "");
  const [category, setCategory] = useState<OperationHistoryCategory | "all">("all");
  const [operatorUserId, setOperatorUserId] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<OperationHistoryResponse>(initialResult);
  const [items, setItems] = useState<OperationHistoryItem[]>(initialResult.success ? initialResult.items : []);
  const [nextCursor, setNextCursor] = useState(initialResult.success ? initialResult.nextCursor : null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selected, setSelected] = useState<OperationHistoryItem | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [contingencyOpen, setContingencyOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ReportResult | null>(null);
  const [snapshotPending, setSnapshotPending] = useState(false);
  const inFlight = useRef(false);
  const loadedMore = useRef(false);
  const skipInitialReload = useRef(true);
  const nextCursorRef = useRef(initialResult.success ? initialResult.nextCursor : null);
  const newestOccurredAt = useRef(initialResult.success ? initialResult.items[0]?.occurredAt ?? null : null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const queryInput = useMemo(() => ({
    eventId,
    period,
    dateFrom: period === "custom" ? dateFrom : null,
    dateTo: period === "custom" ? dateTo : null,
    category,
    operatorUserId: operatorUserId || null,
    search: search || null,
    pageSize: PAGE_SIZE,
  }), [eventId, period, dateFrom, dateTo, category, operatorUserId, search]);

  const load = useCallback(async (mode: "replace" | "more" | "silent") => {
    if (!eventId) return;
    if (inFlight.current) return;
    inFlight.current = true;
    if (mode === "more") setLoadingMore(true);
    else if (mode === "silent") setRefreshing(true);
    else setLoading(true);
    try {
      const response = await getOperationsHistoryAction({
        ...queryInput,
        cursor: mode === "more" ? nextCursorRef.current : null,
      });
      setResult(response);
      if (!response.success) {
        if (mode !== "silent") {
          setItems([]);
          setNextCursor(null);
        }
        return;
      }
      if (mode === "more") {
        loadedMore.current = true;
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...response.items.filter((item) => !seen.has(item.id))];
        });
        nextCursorRef.current = response.nextCursor;
        setNextCursor(response.nextCursor);
      } else if (mode === "silent" && loadedMore.current) {
        const newest = newestOccurredAt.current;
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          const fresh = response.items.filter((item) => {
            if (seen.has(item.id)) return false;
            if (!newest) return true;
            return item.occurredAt > newest;
          });
          return fresh.length ? [...fresh, ...current] : current;
        });
      } else {
        loadedMore.current = false;
        setItems(response.items);
        nextCursorRef.current = response.nextCursor;
        setNextCursor(response.nextCursor);
      }
      newestOccurredAt.current = response.items[0]?.occurredAt ?? newestOccurredAt.current;
    } finally {
      inFlight.current = false;
      setLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
    }
  }, [eventId, queryInput]);

  useEffect(() => {
    if (skipInitialReload.current) {
      skipInitialReload.current = false;
      return;
    }
    loadedMore.current = false;
    void load("replace");
  }, [load]);

  useEffect(() => {
    function tick() {
      if (document.visibilityState !== "visible") return;
      void load("silent");
    }
    const timer = window.setInterval(tick, POLL_MS);
    function onVisibility() {
      if (document.visibilityState === "visible") tick();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const cards = result.success ? result.cards : null;
  const operators = result.success ? result.operators : [];
  const generatedAt = result.success ? result.generatedAt : null;
  const canViewTechnical = result.success ? result.canViewTechnical : false;
  const emptyBecauseFilters = Boolean(search || operatorUserId || (category !== "all")) && (cards?.operations === 0);
  const extraFilterCount = extraHistoryFilterCount({ period, category, operatorUserId });
  const exportQuery = new URLSearchParams();
  if (eventId) exportQuery.set("eventId", eventId);
  if (result.success) {
    exportQuery.set("dateFrom", result.dateFrom);
    exportQuery.set("dateTo", result.dateTo);
  }
  if (search) exportQuery.set("q", search);
  const exportHref = (format: "csv" | "xlsx" | "pdf") => `/api/relatorios/operacoes-historico/${format}?${exportQuery.toString()}`;
  const snapshotHref = (format: "csv" | "xlsx" | "pdf") => `/api/relatorios/operacoes-contingencia/${format}?eventId=${encodeURIComponent(eventId)}`;
  const selectedEventName = events.find((event) => event.id === eventId)?.name ?? "Evento";
  const metricCards = cards
    ? [
      { key: "operations", label: "Operações", short: "Operações", value: cards.operations, tone: "default" as const },
      { key: "kits", label: "Kits entregues", short: "Kits", value: cards.kitsDelivered, tone: "default" as const },
      { key: "checkins", label: "Check-ins", short: "Check-ins", value: cards.checkins, tone: "default" as const },
      { key: "wristbands", label: "Pulseiras", short: "Pulseiras", value: cards.wristbands, tone: "default" as const },
      { key: "corrections", label: "Correções", short: "Correções", value: cards.corrections, tone: cards.corrections ? "warning" as const : "default" as const },
      { key: "issues", label: "Emissões manuais", short: "Emissões", value: cards.manualIssues, tone: "default" as const },
    ]
    : [];

  async function generateSnapshot() {
    if (!eventId) return;
    setSnapshotPending(true);
    setSnapshot(null);
    try {
      const response = await getReportPreviewAction("operacoes-contingencia", { eventId });
      setSnapshot(response);
    } finally {
      setSnapshotPending(false);
    }
  }

  function onPeriodChange(next: HistoryPeriodPreset) {
    setPeriod(next);
    if (next === "custom") setFiltersOpen(true);
  }

  const exportLinks = (
    <>
      <a className="block min-h-11 rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 lg:min-h-0 lg:py-2" href={exportHref("csv")}>CSV</a>
      <a className="block min-h-11 rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 lg:min-h-0 lg:py-2" href={exportHref("xlsx")}>Excel</a>
      <a className="block min-h-11 rounded-lg px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 lg:min-h-0 lg:py-2" href={exportHref("pdf")}>PDF</a>
    </>
  );

  const extraFilters = (
    <div className="space-y-3">
      <div className="space-y-1 text-sm">
        <span className="text-slate-300">Período</span>
        <div className="flex flex-wrap gap-1.5">
          {PERIOD_OPTIONS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onPeriodChange(value)}
              className={`min-h-11 rounded-lg border px-3 text-sm lg:min-h-0 lg:py-1.5 ${period === value ? "border-emerald-400 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-300"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {period === "custom" ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">De</span>
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className={`w-full ${inputClass}`} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Até</span>
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className={`w-full ${inputClass}`} />
          </label>
        </div>
      ) : null}
      <label className="block space-y-1 text-sm">
        <span className="text-slate-300">Tipo de operação</span>
        <select value={category} onChange={(event) => setCategory(event.target.value as OperationHistoryCategory | "all")} className={`w-full ${inputClass}`}>
          {HISTORY_CATEGORIES.map((value) => (
            <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-sm">
        <span className="text-slate-300">Operador</span>
        <select value={operatorUserId} onChange={(event) => setOperatorUserId(event.target.value)} className={`w-full ${inputClass}`}>
          <option value="">Todos</option>
          {operators.map((operator) => (
            <option key={operator.id} value={operator.id}>{operator.name}</option>
          ))}
        </select>
      </label>
      <div className="space-y-1 text-sm">
        <span className="text-slate-300">Exportar</span>
        <div className="flex gap-2">{exportLinks}</div>
      </div>
    </div>
  );

  return (
    <div className="min-w-0 space-y-3 lg:space-y-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-3 lg:hidden">
        <label className="block">
          <span className="sr-only">Evento</span>
          <select
            value={eventId}
            onChange={(event) => setEventId(event.target.value)}
            aria-label={`Evento: ${selectedEventName}`}
            className={`w-full min-w-0 ${inputClass}`}
          >
            {events.map((event) => (
              <option key={event.id} value={event.id}>{event.name}</option>
            ))}
          </select>
        </label>
        <div className="mt-2 flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Período</span>
            <select
              value={period}
              onChange={(event) => onPeriodChange(event.target.value as HistoryPeriodPreset)}
              className={`w-full ${inputClass}`}
            >
              {PERIOD_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void load("replace")}
            aria-label="Atualizar"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-400/70 bg-emerald-500/10 text-emerald-200"
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
          </button>
        </div>
        <label className="relative mt-2 block">
          <span className="sr-only">Buscar</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Buscar..."
            className={`w-full pl-9 ${inputClass}`}
          />
        </label>
        <button
          type="button"
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
          className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-700 px-3 text-sm text-slate-200"
        >
          <SlidersHorizontal className="size-4" aria-hidden />
          {extraFilterCount > 0 ? `Filtros • ${extraFilterCount}` : "Filtros"}
        </button>
        {filtersOpen ? <div className="mt-3 border-t border-slate-800 pt-3">{extraFilters}</div> : null}
      </div>

      <div className="hidden lg:block">
      <AdminFilterBar>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Evento</span>
            <select value={eventId} onChange={(event) => setEventId(event.target.value)} className={inputClass}>
              {events.map((event) => (
                <option key={event.id} value={event.id}>{event.name}</option>
              ))}
            </select>
          </label>
          <div className="space-y-1 text-sm">
            <span className="text-slate-300">Período</span>
            <div className="flex flex-wrap gap-1.5">
              {PERIOD_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setPeriod(value)}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${period === value ? "border-emerald-400 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-300"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {period === "custom" ? (
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
          <label className="min-w-[16rem] flex-1 space-y-1 text-sm">
            <span className="text-slate-300">Busca</span>
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Buscar participante, ingresso, pedido ou operador"
              className={`w-full ${inputClass}`}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Tipo de operação</span>
            <select value={category} onChange={(event) => setCategory(event.target.value as OperationHistoryCategory | "all")} className={inputClass}>
              {HISTORY_CATEGORIES.map((value) => (
                <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Operador</span>
            <select value={operatorUserId} onChange={(event) => setOperatorUserId(event.target.value)} className={inputClass}>
              <option value="">Todos</option>
              {operators.map((operator) => (
                <option key={operator.id} value={operator.id}>{operator.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void load("replace")}
            className="h-9 rounded-xl border border-emerald-400/70 bg-emerald-500/10 px-4 text-sm font-semibold text-emerald-200"
          >
            Atualizar
          </button>
          <div className="relative">
            <button type="button" onClick={() => setExportOpen((open) => !open)} className="h-9 rounded-xl border border-slate-700 px-4 text-sm text-slate-300">
              Exportar
            </button>
            {exportOpen ? (
              <div className="absolute right-0 z-20 mt-2 w-40 rounded-xl border border-slate-700 bg-slate-900 p-1 shadow-xl">
                {exportLinks}
              </div>
            ) : null}
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          {generatedAt ? secondsAgoLabel(generatedAt, nowMs) : null}
          {refreshing ? " · Atualizando" : null}
        </p>
      </AdminFilterBar>
      </div>

      {metricCards.length ? (
        <div className="min-w-0 w-full overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:thin] lg:overflow-visible">
          <div className="flex w-max gap-2 pb-1 lg:grid lg:w-full lg:grid-cols-6 lg:gap-2 lg:pb-0">
            {metricCards.map((card) => (
              <article
                key={card.key}
                className={`flex h-[4.85rem] w-[7.75rem] shrink-0 flex-col justify-center rounded-xl border px-2.5 py-2 lg:h-[4.75rem] lg:w-auto ${
                  card.tone === "warning" ? "border-amber-500/30 bg-slate-950/80" : "border-slate-800 bg-slate-950/80"
                }`}
              >
                <p className={`text-2xl font-semibold leading-none ${card.tone === "warning" ? "text-amber-200" : "text-white"}`}>{card.value}</p>
                <p className="mt-1 truncate text-[11px] leading-4 text-slate-400">
                  <span className="xl:hidden">{card.short}</span>
                  <span className="hidden xl:inline">{card.label}</span>
                </p>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      <AdminSection
        compact
        title="Atividade recente"
        actions={
          generatedAt ? (
            <p className="flex items-center gap-1.5 text-xs text-slate-400" aria-live="polite">
              <span className="size-1.5 rounded-full bg-emerald-400" aria-hidden />
              {refreshing ? "Atualizando" : liveStatus(generatedAt, nowMs)}
            </p>
          ) : null
        }
      >
        {!result.success ? (
          <AdminEmptyState title="Não foi possível carregar o histórico" description={result.message} action={
            <button type="button" onClick={() => void load("replace")} className="min-h-11 rounded-xl border border-slate-600 px-4 text-sm text-slate-200">Tentar de novo</button>
          } />
        ) : loading && items.length === 0 ? (
          <div className="space-y-1">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="h-[4.5rem] animate-pulse rounded-lg border border-slate-800 bg-slate-950/70" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <AdminEmptyState
            title={emptyBecauseFilters ? "Nenhuma operação com esses filtros" : "Sem operações no período"}
            description={emptyBecauseFilters
              ? "Ajuste a busca, o tipo ou o operador para ver resultados."
              : "Ainda não há atividade operacional neste evento para o período selecionado."}
          />
        ) : (
          <ul className="divide-y divide-slate-800 overflow-hidden rounded-xl border border-slate-800">
            {items.map((item) => {
              const tone = feedTone(item);
              const Icon = FEED_ICONS[feedIconKind(item)];
              const meta = feedMetaLine(item);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => { setSelected(item); setShowTechnical(false); }}
                    className="flex min-h-[4.25rem] w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-slate-800/60 sm:px-3"
                  >
                    <Icon className={`mt-0.5 size-4 shrink-0 ${TONE_CLASS[tone]}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className={`truncate text-[11px] font-semibold uppercase tracking-[0.14em] ${TONE_CLASS[tone]}`}>{item.title}</p>
                        <time className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400">{formatFeedOccurredAt(item.occurredAt, period)}</time>
                      </div>
                      <p className="truncate text-sm leading-5 text-slate-100">{feedParticipantLine(item)}</p>
                      {meta ? <p className="truncate text-[12px] leading-4 text-slate-400">{meta}</p> : null}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {result.success && nextCursor ? (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void load("more")}
              className="inline-flex h-11 min-w-[10rem] items-center justify-center rounded-xl border border-slate-600 px-4 text-sm text-slate-200 disabled:opacity-60"
            >
              {loadingMore ? "Carregando…" : "Carregar mais"}
            </button>
          </div>
        ) : null}
        {result.success && result.truncated ? (
          <p className="mt-3 text-xs text-amber-200">O período é grande demais para uma varredura completa. Refine as datas se precisar de 100% dos registros.</p>
        ) : null}
      </AdminSection>

      <section className="overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-900/70">
        <button
          type="button"
          onClick={() => setContingencyOpen((open) => !open)}
          aria-expanded={contingencyOpen}
          className="flex min-h-11 w-full items-center justify-between px-3 text-left lg:hidden"
        >
          <span className="text-sm font-semibold text-white">Contingência</span>
          <span className="text-slate-400" aria-hidden>{contingencyOpen ? "▾" : ">"}</span>
        </button>
        <div className={`${contingencyOpen ? "block" : "hidden"} px-3 pb-3 lg:block lg:p-4`}>
          <div className="hidden items-start justify-between gap-3 lg:flex">
            <div>
              <h2 className="text-base font-semibold text-white">Contingência</h2>
              <p className="mt-0.5 text-xs text-slate-300">Baixe uma fotografia atual dos ingressos para uso caso o sistema fique indisponível.</p>
            </div>
            <button
              type="button"
              onClick={() => void generateSnapshot()}
              disabled={!eventId || snapshotPending}
              className="h-9 rounded-xl border border-slate-600 px-4 text-sm text-slate-200 disabled:opacity-60"
            >
              {snapshotPending ? "Gerando…" : "Gerar snapshot"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void generateSnapshot()}
            disabled={!eventId || snapshotPending}
            className="mb-2 inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-slate-600 px-4 text-sm text-slate-200 disabled:opacity-60 lg:hidden"
          >
            {snapshotPending ? "Gerando…" : "Gerar snapshot"}
          </button>
          {snapshot?.success ? (
            <div className="flex flex-wrap gap-2 text-sm">
              <p className="text-slate-300">{snapshot.subtitle}</p>
              <a className="inline-flex min-h-11 items-center rounded-lg border border-slate-600 px-3 text-slate-200 lg:min-h-0 lg:py-1.5" href={snapshotHref("csv")}>CSV</a>
              <a className="inline-flex min-h-11 items-center rounded-lg border border-slate-600 px-3 text-slate-200 lg:min-h-0 lg:py-1.5" href={snapshotHref("xlsx")}>Excel</a>
              <a className="inline-flex min-h-11 items-center rounded-lg border border-slate-600 px-3 text-slate-200 lg:min-h-0 lg:py-1.5" href={snapshotHref("pdf")}>PDF</a>
            </div>
          ) : snapshot && !snapshot.success ? (
            <p className="text-sm text-rose-300">{snapshot.message}</p>
          ) : (
            <p className="text-sm text-slate-500">O snapshot não é o histórico de operações — é o estado atual dos ingressos.</p>
          )}
        </div>
      </section>

      <SlideOverPanel open={Boolean(selected)} title={selected?.title ?? "Operação"} onClose={() => setSelected(null)} mobileSheet>
        {selected ? (
          <dl className="space-y-3 text-sm">
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Operação</dt><dd className="text-slate-100">{selected.title}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Participante</dt><dd className="text-slate-100">{selected.participantName ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Ingresso</dt><dd className="text-slate-100">{selected.ticketCode ?? "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Evento</dt><dd className="text-slate-100">{selected.eventName || "—"}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Operador</dt><dd className="text-slate-100">{selected.operatorName}</dd></div>
            <div><dt className="text-xs uppercase tracking-wide text-slate-500">Data/hora</dt><dd className="text-slate-100">{new Date(selected.occurredAt).toLocaleString("pt-BR")}</dd></div>
            {selected.reason ? <div><dt className="text-xs uppercase tracking-wide text-slate-500">Motivo</dt><dd className="text-slate-100">{selected.reason}</dd></div> : null}
            {selected.stateChanges.map((change) => (
              <div key={change.label}>
                <dt className="text-xs uppercase tracking-wide text-slate-500">{change.label}</dt>
                <dd className="text-slate-100">{[change.previous, change.next].filter(Boolean).length === 2 ? `${change.previous} → ${change.next}` : change.next ?? change.previous}</dd>
              </div>
            ))}
            {canViewTechnical ? (
              <div className="pt-2">
                <button type="button" onClick={() => setShowTechnical((open) => !open)} className="min-h-11 text-sm text-emerald-300 lg:min-h-0">
                  {showTechnical ? "Ocultar dados técnicos" : "Ver dados técnicos"}
                </button>
                {showTechnical && selected.technical ? (
                  <pre className="mt-2 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300">
                    {JSON.stringify(selected.technical, null, 2)}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </dl>
        ) : null}
      </SlideOverPanel>
    </div>
  );
}
