"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { AdminStatusBadge } from "@/components/admin/AdminStatusBadge";
import { searchAdminGloballyAction } from "@/lib/admin/global-search/action.ts";
import { flattenSearchHits } from "@/lib/admin/global-search/present.ts";
import { GLOBAL_SEARCH_DEBOUNCE_MS, GLOBAL_SEARCH_NAME_MIN_CHARS } from "@/lib/admin/global-search/constants.ts";
import type { GlobalSearchHit, GlobalSearchResult } from "@/lib/admin/global-search/types.ts";

const OPEN_EVENT = "militrin:open-global-search";

function isModK(event: KeyboardEvent) {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
}

function shortcutLabel() {
  if (typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)) {
    return "⌘K";
  }
  return "Ctrl+K";
}

export function openAdminGlobalSearch() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function GlobalSearchDesktopTrigger() {
  const [hotkey, setHotkey] = useState("Ctrl+K");
  useEffect(() => { setHotkey(shortcutLabel()); }, []);
  return (
    <button
      type="button"
      onClick={() => openAdminGlobalSearch()}
      className="mb-6 flex w-full items-center gap-3 rounded-2xl border border-slate-700/80 bg-slate-950/70 px-4 py-3 text-left text-sm text-slate-400 transition hover:border-emerald-400/40 hover:text-slate-200"
      aria-label="Buscar pessoa, pedido, ingresso, QR ou pulseira"
    >
      <Search size={16} className="shrink-0 text-emerald-300" />
      <span className="min-w-0 flex-1 truncate">Buscar pessoa, pedido, ingresso...</span>
      <kbd className="rounded-md border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-slate-400">
        {hotkey}
      </kbd>
    </button>
  );
}

export function GlobalSearchMobileTrigger() {
  return (
    <button
      type="button"
      onClick={() => openAdminGlobalSearch()}
      aria-label="Buscar pessoa, pedido, ingresso, QR ou pulseira"
      title="Buscar"
      className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-2.5 text-emerald-200 active:bg-emerald-500/20"
    >
      <Search size={16} />
      <span className="text-xs font-semibold">Buscar</span>
    </button>
  );
}

export function GlobalSearchPalette() {
  const router = useRouter();
  const inputId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<GlobalSearchResult>({ status: "idle" });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const [hotkey, setHotkey] = useState("Ctrl+K");

  useEffect(() => {
    setHotkey(shortcutLabel());
  }, []);

  useEffect(() => {
    function onOpen() { setOpen(true); }
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isModK(event)) {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResult({ status: "idle" });
      setLoading(false);
      return;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchAdminGloballyAction(trimmed).then((next) => {
        if (requestRef.current !== requestId) return;
        setResult(next);
        setSelected(0);
        setLoading(false);
      }).catch(() => {
        if (requestRef.current !== requestId) return;
        setResult({ status: "error", message: "Não foi possível realizar a busca. Tente novamente." });
        setLoading(false);
      });
    }, GLOBAL_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  const hits = useMemo(
    () => (result.status === "ok" ? flattenSearchHits(result.groups) : []),
    [result],
  );

  function close() {
    setOpen(false);
    setQuery("");
    setResult({ status: "idle" });
    setSelected(0);
  }

  function openHit(hit: GlobalSearchHit | undefined) {
    if (!hit?.href) return;
    close();
    router.push(hit.href);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      openHit(hits[selected]);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby={inputId}>
      <button type="button" aria-label="Fechar busca" className="absolute inset-0 bg-slate-950/75 backdrop-blur-sm" onClick={close} />
      <div className="relative flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-slate-700 bg-slate-950 shadow-2xl sm:max-h-[80vh] sm:rounded-3xl">
        <div className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950 p-4">
          <div className="flex items-center gap-3">
            <Search size={18} className="shrink-0 text-emerald-300" />
            <input
              ref={inputRef}
              id={inputId}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              placeholder="Buscar pessoa, pedido, ingresso..."
              className="h-12 min-w-0 flex-1 bg-transparent text-base text-slate-100 outline-none placeholder:text-slate-500"
            />
            <kbd className="hidden rounded-md border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 sm:inline">{hotkey}</kbd>
            <button type="button" onClick={close} aria-label="Fechar" className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-700 text-slate-300 active:bg-slate-800">
              <X size={18} />
            </button>
          </div>
        </div>

        <div id={listId} role="listbox" className="min-h-0 flex-1 overflow-y-auto p-3 pb-[max(1rem,var(--safe-bottom))]">
          <SearchBody
            query={query}
            loading={loading}
            result={result}
            hits={hits}
            selected={selected}
            onSelect={openHit}
            onHover={setSelected}
          />
        </div>
      </div>
    </div>
  );
}

function SearchBody({
  query,
  loading,
  result,
  hits,
  selected,
  onSelect,
  onHover,
}: {
  query: string;
  loading: boolean;
  result: GlobalSearchResult;
  hits: GlobalSearchHit[];
  selected: number;
  onSelect: (hit: GlobalSearchHit) => void;
  onHover: (index: number) => void;
}) {
  if (!query.trim()) {
    return (
      <div className="space-y-3 px-2 py-6 text-sm text-slate-400">
        <p>Busque por nome, CPF, e-mail, telefone, pedido, ingresso, QR ou pulseira.</p>
        <p className="text-xs text-slate-500">Exemplos: Higor · #001966 · MIL-2026-00002055 · CPF · código da pulseira</p>
      </div>
    );
  }

  if (loading && result.status === "idle") {
    return <p className="px-2 py-6 text-sm text-slate-400">Buscando...</p>;
  }

  if (result.status === "too_short") {
    return <p className="px-2 py-6 text-sm text-slate-400">Digite pelo menos {result.minChars || GLOBAL_SEARCH_NAME_MIN_CHARS} caracteres.</p>;
  }

  if (result.status === "error") {
    return <p className="px-2 py-6 text-sm text-rose-200">{result.message}</p>;
  }

  if (!loading && (result.status === "empty" || (result.status === "ok" && !hits.length))) {
    return <p className="px-2 py-6 text-sm text-slate-400">Nenhum resultado encontrado para “{query.trim()}”.</p>;
  }

  if (result.status !== "ok") {
    return loading ? <p className="px-2 py-6 text-sm text-slate-400">Buscando...</p> : null;
  }

  let offset = 0;
  return (
    <div className="space-y-5">
      {loading ? <p className="px-2 text-xs text-slate-500">Buscando...</p> : null}
      {result.groups.map((group) => {
        const groupHits = flattenSearchHits([group]);
        const start = offset;
        offset += groupHits.length;
        return (
          <section key={group.id} className="space-y-2">
            <h2 className="px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{group.label}</h2>
            <div className="space-y-1">
              {groupHits.map((hit, index) => {
                const absolute = start + index;
                const active = absolute === selected;
                return (
                  <button
                    key={hit.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => onHover(absolute)}
                    onClick={() => onSelect(hit)}
                    className={`flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 py-3 text-left ${active ? "bg-emerald-500/15 ring-1 ring-emerald-400/40" : "hover:bg-slate-900"}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-100">{hit.title}</span>
                      {hit.subtitle ? <span className="mt-0.5 block truncate text-sm text-slate-400">{hit.subtitle}</span> : null}
                      {hit.meta ? <span className="mt-0.5 block truncate text-xs text-slate-500">{hit.meta}</span> : null}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      {hit.statusKey ? <AdminStatusBadge status={hit.statusKey} /> : hit.statusLabel ? <span className="text-xs text-slate-300">{hit.statusLabel}</span> : null}
                      <span className="text-[11px] font-medium text-emerald-300">{hit.cta}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
