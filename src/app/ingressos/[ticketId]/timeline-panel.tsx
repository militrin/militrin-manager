"use client";

import { FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { TicketTimelineResult } from "@/lib/admin/ticket-timeline";
import { formatReportDateTime } from "@/lib/reports/report-theme";

type Filters = { from?: string; to?: string; type?: string; scope?: "ticket" | "account"; eventId?: string };
type NavigationMode = "replace" | "push";

export function AdministrativeTicketTimeline({ result, filters }: { result: TicketTimelineResult; filters: Filters }) {
  const router = useRouter();
  const pathname = usePathname();
  const currentSearchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const lastTarget = useRef<string | null>(null);
  const activeControl = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const canonicalQuery = new URLSearchParams(currentSearchParams.toString());
  if (filters.from) canonicalQuery.set("from", filters.from); else canonicalQuery.delete("from");
  if (filters.to) canonicalQuery.set("to", filters.to); else canonicalQuery.delete("to");
  if (result.appliedTypeCode) canonicalQuery.set("type", result.appliedTypeCode); else canonicalQuery.delete("type");
  canonicalQuery.set("scope", result.scope);
  if (result.appliedEventId) canonicalQuery.set("eventId", result.appliedEventId); else canonicalQuery.delete("eventId");

  const navigate = (params: URLSearchParams, mode: NavigationMode, control?: HTMLElement | null) => {
    if (isPending) return;
    setNavigationError(null);
    activeControl.current = control ?? null;
    const query = params.toString();
    const target = query ? `${pathname}?${query}` : pathname;
    lastTarget.current = target;
    startTransition(() => {
      try {
        router[mode](target, { scroll: false });
      } catch (error) {
        console.error("[ticket-timeline:navigation]", error);
        setNavigationError("Não foi possível atualizar o histórico.");
      }
    });
  };

  useEffect(() => {
    if (isPending) return;
    const control = activeControl.current;
    if (control?.isConnected) control.focus({ preventScroll: true });
    else if (activeControl.current) titleRef.current?.focus({ preventScroll: true });
    activeControl.current = null;
  }, [isPending, result]);

  const switchScope = (scope: "ticket" | "account", control: HTMLButtonElement) => {
    const next = new URLSearchParams(canonicalQuery);
    next.set("scope", scope);
    next.delete("page");
    next.delete("eventId");
    navigate(next, "replace", control);
  };

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams(canonicalQuery);
    const allowedTypes = new Set(result.availableTypes.map((option) => option.code));
    const allowedEvents = new Set(result.availableEvents.map((option) => option.id));
    const from = String(form.get("from") ?? "");
    const to = String(form.get("to") ?? "");
    const type = String(form.get("type") ?? "");
    const eventId = String(form.get("eventId") ?? "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) next.set("from", from); else next.delete("from");
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) next.set("to", to); else next.delete("to");
    if (allowedTypes.has(type)) next.set("type", type); else next.delete("type");
    if (result.scope === "account" && allowedEvents.has(eventId)) next.set("eventId", eventId); else next.delete("eventId");
    next.set("scope", result.scope);
    next.delete("page");
    navigate(next, "replace", event.currentTarget.querySelector<HTMLButtonElement>("button[type=submit]"));
  };

  const paginate = (page: number, control: HTMLButtonElement) => {
    const next = new URLSearchParams(canonicalQuery);
    next.set("page", String(page));
    navigate(next, "push", control);
  };

  const retry = () => {
    if (!lastTarget.current || isPending) return;
    startTransition(() => router.replace(lastTarget.current!, { scroll: false }));
  };

  const exportQuery = canonicalQuery.toString();
  const exportBase = `/api/ingressos/${result.header.ticketId}/historico`;
  const controlsDisabled = isPending;

  return <section id="historico" aria-busy={isPending} className="ticket-history-print space-y-5 rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
    <style jsx global>{`@page { size:A4; margin:16mm 14mm 18mm } @media print { html,body { background:#fff!important;color:#1f2937!important } body * { visibility:hidden!important } .ticket-history-print,.ticket-history-print * { visibility:visible!important } .ticket-history-print { position:absolute;inset:0;background:#fff!important;color:#1f2937!important;border:0!important;padding:0!important } .ticket-history-no-print { display:none!important } .ticket-history-print header { border-bottom:2px solid #047857;padding-bottom:10px } .ticket-history-print article { break-inside:avoid;page-break-inside:avoid;border:1px solid #d1d5db!important;background:#fff!important;color:#1f2937!important;box-shadow:none!important } .ticket-history-print article time,.ticket-history-print .text-slate-400,.ticket-history-print .text-slate-300,.ticket-history-print .text-slate-500 { color:#4b5563!important } .report-technical-id { font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;word-break:break-word } .report-print-meta,.report-print-footer { display:block!important;color:#4b5563!important;font-size:9pt } .report-print-footer { position:fixed;bottom:-11mm;left:0;right:0;border-top:1px solid #d1d5db;padding-top:3mm } .report-print-footer::after { content:"Página " counter(page);float:right } }`}</style>
    <header><p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Histórico administrativo</p><h2 ref={titleRef} tabIndex={-1} className="mt-1 text-xl font-semibold outline-none">{result.hasPartialHistory ? "Linha do tempo disponível" : "Linha do tempo comprovada"}</h2>
      {result.scope === "ticket" ? <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3"><p>Ingresso: {result.header.ticketId}</p><p>Evento: {result.header.eventName}</p><p>Pedido: {result.header.orderNumber}</p><p>Titular: {result.header.holderName}</p><p>Status: {result.header.status}</p><p>Total: {result.total} evento(s)</p></div> : <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><p>{result.appliedEventId ? `Evento filtrado: ${result.header.filteredEventName ?? "Evento"}` : "Eventos: Todos os eventos"}</p><p>Conta de: {result.header.holderName}</p><p>Total: {result.total} evento(s)</p></div>}
      <p className="mt-2 text-xs text-slate-400">Filtro de tipo: {result.appliedTypeLabel ?? "Todos os tipos"}</p>
      {result.scope === "ticket" ? <div className="mt-2 text-xs text-slate-400"><strong className="text-emerald-700">Pedido: {result.header.orderNumber}</strong><p className="report-technical-id mt-1">Ingresso: {result.header.ticketId}</p></div> : null}
      <p className="report-print-meta hidden">Gerado em {formatReportDateTime(result.generatedAt)} · America/Sao_Paulo</p>
    </header>
    <p aria-live="polite" className="min-h-5 text-xs text-slate-400">{isPending ? "Atualizando histórico…" : ""}</p>
    {navigationError ? <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"><p>{navigationError}</p><button type="button" disabled={isPending} onClick={retry} className="mt-2 rounded border border-rose-300/50 px-2 py-1 disabled:opacity-50">Tentar novamente</button></div> : null}
    {result.hasPartialHistory ? <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">Não foi possível carregar parte do histórico</p> : null}
    <div className="ticket-history-no-print flex gap-2"><button type="button" disabled={controlsDisabled} onClick={(event) => switchScope("ticket", event.currentTarget)} className={`rounded-lg px-3 py-2 disabled:opacity-50 ${result.scope === "ticket" ? "bg-emerald-400 text-slate-950" : "border border-slate-700"}`}>Este ingresso</button><button type="button" disabled={controlsDisabled} onClick={(event) => switchScope("account", event.currentTarget)} className={`rounded-lg px-3 py-2 disabled:opacity-50 ${result.scope === "account" ? "bg-emerald-400 text-slate-950" : "border border-slate-700"}`}>Histórico completo da conta</button></div>
    <form onSubmit={applyFilters} className="ticket-history-no-print grid gap-3 md:grid-cols-5"><input type="hidden" name="scope" value={result.scope}/><label className="text-sm">De<input disabled={controlsDisabled} name="from" type="date" defaultValue={filters.from} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 p-2 disabled:opacity-50"/></label><label className="text-sm">Até<input disabled={controlsDisabled} name="to" type="date" defaultValue={filters.to} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 p-2 disabled:opacity-50"/></label><label className="text-sm">Tipo<select disabled={controlsDisabled} key={result.appliedTypeCode ?? "all-types"} name="type" defaultValue={result.appliedTypeCode ?? ""} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 p-2 disabled:opacity-50"><option value="">Todos os tipos</option>{result.availableTypes.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</select></label>{result.scope === "account" ? <label className="text-sm">Evento<select disabled={controlsDisabled} key={result.appliedEventId ?? "all-events"} name="eventId" defaultValue={result.appliedEventId ?? ""} className="mt-1 block w-full rounded-lg border border-slate-700 bg-slate-950 p-2 disabled:opacity-50"><option value="">Todos os eventos</option>{result.availableEvents.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}</select></label> : null}<button type="submit" disabled={controlsDisabled} className="self-end rounded-lg bg-emerald-400 px-3 py-2 font-semibold text-slate-950 disabled:opacity-50">Filtrar</button></form>
    <div className="ticket-history-no-print flex flex-wrap gap-2"><button type="button" disabled={controlsDisabled} onClick={() => window.print()} className="rounded-lg border border-slate-600 px-3 py-2 disabled:opacity-50">Imprimir histórico</button><a href={`${exportBase}/pdf?${exportQuery}`} className="rounded-lg border border-slate-600 px-3 py-2">Exportar PDF</a><a href={`${exportBase}/xlsx?${exportQuery}`} className="rounded-lg border border-emerald-600 px-3 py-2 text-emerald-200">Exportar Excel</a><a href={`${exportBase}/csv?${exportQuery}`} className="rounded-lg border border-slate-600 px-3 py-2">Exportar CSV</a></div>
    <div className="space-y-3">{result.events.map((event) => <article key={event.id} className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"><div className="grid gap-2 sm:grid-cols-[150px_1fr]"><time className="text-xs text-slate-400">{formatReportDateTime(event.occurredAt)}</time><div><strong>{event.label}</strong>{event.description ? <p className="mt-1 text-sm text-slate-300">{event.description}</p> : null}{event.hasTransition ? <p className="mt-2 text-sm font-semibold">{event.previousState}<span className="mx-2 text-emerald-600">→</span>{event.newState}</p> : null}<p className="mt-2 text-xs text-slate-400"><span className="font-semibold">Realizado por:</span> {event.operator}</p>{event.reason ? <p className="mt-1 text-xs text-slate-400"><span className="font-semibold">Motivo:</span> {event.reason}</p> : null}{event.observation ? <p className="mt-1 text-xs text-slate-400"><span className="font-semibold">Observação:</span> {event.observation}</p> : null}{event.detail ? <p className="mt-1 text-sm text-slate-300"><span className="font-semibold">Alteração:</span> {event.detail}</p> : null}{result.scope === "account" && (event.relatedTicketId || event.relatedOrderId) ? <div className="report-technical-id mt-2 text-xs text-slate-500"><p>Ingresso: {event.relatedTicketId ?? "Não relacionado"}</p><p>Pedido: {event.relatedOrderId ?? "Não relacionado"}</p></div> : null}</div></div></article>)}</div>
    {result.technicalEventCount > 0 ? <aside className="ticket-history-no-print rounded-lg border border-slate-700 p-3 text-sm"><p>Existem {result.technicalEventCount} registros técnicos adicionais.</p>{result.canViewTechnicalAudit ? <details className="mt-2"><summary className="cursor-pointer font-semibold">Auditoria técnica</summary><div className="mt-2 space-y-2">{result.technicalEvents.map((event) => <p key={event.id} className="rounded bg-slate-950 p-2"><strong>{event.type}</strong> · {formatReportDateTime(event.occurredAt)}</p>)}</div></details> : null}</aside> : null}
    <nav className="ticket-history-no-print flex justify-between"><button type="button" disabled={controlsDisabled || result.page <= 1} onClick={(event) => paginate(result.page - 1, event.currentTarget)} className="rounded-lg border border-slate-700 px-3 py-2 disabled:opacity-40">Anterior</button><span className="text-sm">Página {result.page}</span><button type="button" disabled={controlsDisabled || result.page * result.pageSize >= result.total} onClick={(event) => paginate(result.page + 1, event.currentTarget)} className="rounded-lg border border-slate-700 px-3 py-2 disabled:opacity-40">Próxima</button></nav>
    <footer className="report-print-footer hidden">Militrin · Histórico administrativo</footer>
  </section>;
}
