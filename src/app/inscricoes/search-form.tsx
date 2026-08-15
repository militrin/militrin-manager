"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Filter, Search, SlidersHorizontal, UserPlus, X } from "lucide-react";

// â”€â”€ tipos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type Props = {
  eventId: string;
  events: { id: string; name: string }[];
  initialQ: string;
  initialFilters: FilterValues;
};

type FilterValues = {
  city: string;
  category: string;
  batch: string;
  shirtType: string;
  shirtSize: string;
  paymentStatus: string;
  orderStatus: string;
  kitDelivered: string;
  checkin: string;
  dataIssues: string;
};

const FILTER_LABELS: Record<string, string> = {
  city: "Cidade",
  category: "Categoria",
  batch: "Lote",
  shirtType: "Camiseta",
  shirtSize: "Tamanho",
  paymentStatus: "Pagamento",
  orderStatus: "Pedido",
  kitDelivered: "Kit",
  checkin: "Check-in",
  dataIssues: "Pendências",
};

const EMPTY: FilterValues = {
  city: "", category: "", batch: "", shirtType: "", shirtSize: "",
  paymentStatus: "", orderStatus: "", kitDelivered: "", checkin: "", dataIssues: "",
};

// â”€â”€ hook de debounce â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function useDebounce<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
// â”€â”€ spinner inline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-emerald-400"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
// â”€â”€ componente â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function ParticipantsSearchForm({ eventId, events, initialQ, initialFilters }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [q, setQ] = useState(initialQ);
  const [filters, setFilters] = useState<FilterValues>(initialFilters);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const debouncedQ = useDebounce(q, 350);

  const mountedRef = useRef(false);
  const lastPushedRef = useRef({ q: initialQ, filters: initialFilters });

  const push = useCallback(
    (nextQ: string, nextFilters: FilterValues, nextEvent: string) => {
      const params = new URLSearchParams();
      params.set("eventId", nextEvent);
      params.set("page", "1");
      if (nextQ.trim()) params.set("q", nextQ.trim());
      Object.entries(nextFilters).forEach(([k, v]) => {
        if (v && v !== "all") params.set(k, v);
      });
      startTransition(() => {
        router.push(`/inscricoes?${params.toString()}`);
      });
    },
    [router],
  );

  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    const prev = lastPushedRef.current;
    if (debouncedQ === prev.q && filters === prev.filters) return;
    lastPushedRef.current = { q: debouncedQ, filters };
    push(debouncedQ, filters, eventId);
    if (debouncedQ !== prev.q) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [debouncedQ, eventId, filters, push]);

  function setFilterAndPush(key: keyof FilterValues, value: string) {
    const next = { ...filters, [key]: value };
    setFilters(next);
    lastPushedRef.current = { q: debouncedQ, filters: next };
    push(debouncedQ, next, eventId);
  }

  function clearFilter(key: keyof FilterValues) {
    setFilterAndPush(key, "");
  }

  function clearAll() {
    setFilters(EMPTY);
    setQ("");
    lastPushedRef.current = { q: "", filters: EMPTY };
    push("", EMPTY, eventId);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  const activeChips = Object.entries(filters)
    .filter(([, v]) => v && v !== "all")
    .map(([k, v]) => ({ key: k as keyof FilterValues, label: FILTER_LABELS[k] ?? k, value: v }));

  const inputCls =
    "h-9 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none transition";
  const selectCls =
    "h-9 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none transition";

  return (
    <div className="space-y-3">

      {/* â”€â”€ Linha 1: campo de busca â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="relative">
        <Search
          size={16}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"
        />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por nome, CPF, telefone ou e-mail..."
          autoComplete="off"
          className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-900 pl-11 pr-12 text-sm text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none transition"
        />
        {isPending && (
          <span className="absolute right-4 top-1/2 -translate-y-1/2">
            <Spinner />
          </span>
        )}
        {!isPending && q && (
          <button
            type="button"
            onClick={() => { setQ(""); requestAnimationFrame(() => inputRef.current?.focus()); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
            aria-label="Limpar busca"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* â”€â”€ Linha 2: evento + filtros + nova inscriÃ§Ã£o â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="flex flex-wrap items-center gap-2">

        {/* Seletor de evento â€” styled select */}
        {events.length > 1 && (
          <select
            value={eventId}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams.toString());
              params.set("eventId", e.target.value);
              params.set("page", "1");
              router.push(`/inscricoes?${params.toString()}`);
            }}
            className="h-9 rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none transition max-w-[200px]"
          >
            {events.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        )}

        {/* BotÃ£o Filtros com indicador */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`flex h-9 items-center gap-2 rounded-xl border px-4 text-sm font-medium transition ${
            open || activeChips.length > 0
              ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
              : "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white"
          }`}
        >
          <SlidersHorizontal size={14} />
          Filtros
          {activeChips.length > 0 && (
            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-emerald-500/30 px-1 text-xs font-bold text-emerald-200">
              {activeChips.length}
            </span>
          )}
          <Filter size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>

        {/* EspaÃ§ador */}
        <div className="flex-1" />

        {/* Nova inscriÃ§Ã£o â€” destaque */}
        <Link
          href="/cadastros/novo"
          className="flex h-9 items-center gap-2 rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 active:bg-emerald-600 transition"
        >
          <UserPlus size={15} />
          Nova inscriÃ§Ã£o
        </Link>
      </div>

      {/* â”€â”€ Chips de filtros ativos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {activeChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {activeChips.map(({ key, label, value }) => (
            <span
              key={key}
              className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200"
            >
              <span className="font-medium">{label}:</span> {value}
              <button
                type="button"
                onClick={() => clearFilter(key)}
                className="ml-0.5 rounded-full p-0.5 hover:bg-emerald-500/20 hover:text-white transition"
                aria-label={`Remover filtro ${label}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-slate-500 underline hover:text-slate-300 transition"
          >
            Limpar todos
          </button>
        </div>
      )}

      {/* â”€â”€ Painel de filtros â€” animaÃ§Ã£o via CSS grid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div
        className={`grid transition-all duration-200 ease-in-out ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 pt-3">
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Filtros avanÃ§ados
            </p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              <input value={filters.city} onChange={(e) => setFilterAndPush("city", e.target.value)} placeholder="Cidade" className={inputCls} />
              <input value={filters.category} onChange={(e) => setFilterAndPush("category", e.target.value)} placeholder="Categoria" className={inputCls} />
              <input value={filters.batch} onChange={(e) => setFilterAndPush("batch", e.target.value)} placeholder="Lote" className={inputCls} />
              <input value={filters.shirtType} onChange={(e) => setFilterAndPush("shirtType", e.target.value)} placeholder="Tipo de camiseta" className={inputCls} />
              <input value={filters.shirtSize} onChange={(e) => setFilterAndPush("shirtSize", e.target.value)} placeholder="Tamanho" className={inputCls} />

              <select value={filters.paymentStatus} onChange={(e) => setFilterAndPush("paymentStatus", e.target.value)} className={selectCls}>
                <option value="">Pagamento â€” todos</option>
                <option value="pending">Pendente</option>
                <option value="confirmed">Confirmado</option>
                <option value="cancelled">Cancelado</option>
              </select>

              <select value={filters.orderStatus} onChange={(e) => setFilterAndPush("orderStatus", e.target.value)} className={selectCls}>
                <option value="">Pedido â€” todos</option>
                <option value="pending">Pendente</option>
                <option value="confirmed">Confirmado</option>
                <option value="cancelled">Cancelado</option>
                <option value="expired">Expirado</option>
              </select>

              <select value={filters.kitDelivered} onChange={(e) => setFilterAndPush("kitDelivered", e.target.value)} className={selectCls}>
                <option value="">Kit â€” todos</option>
                <option value="yes">Entregue</option>
                <option value="no">Pendente</option>
              </select>

              <select value={filters.checkin} onChange={(e) => setFilterAndPush("checkin", e.target.value)} className={selectCls}>
                <option value="">Check-in â€” todos</option>
                <option value="yes">Realizado</option>
                <option value="no">NÃ£o realizado</option>
              </select>

              <select value={filters.dataIssues} onChange={(e) => setFilterAndPush("dataIssues", e.target.value)} className={selectCls}>
                <option value="">Pendências — todos</option>
                <option value="yes">Com pendências</option>
              </select>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
