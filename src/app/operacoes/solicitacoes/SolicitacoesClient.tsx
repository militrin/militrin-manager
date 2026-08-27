"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AdminEmptyState } from "@/components/admin";
import { reviewTicketItemChangeAction } from "@/app/minha-conta/actions";

export type PendingChangeRequestRow = {
  id: string;
  ticketId: string;
  ticketReference: string;
  eventId: string;
  eventName: string;
  kitItemName: string;
  holderName: string;
  currentLabel: string;
  requestedLabel: string;
  requestedVariantId: string;
  requestedAt: string;
  reason: string | null;
  stock: { tracked: boolean; available: number | null };
};

const REJECT_REASON_OPTIONS = [
  { value: "out_of_stock", label: "Sem estoque no tamanho/opção solicitada" },
  { value: "duplicate_request", label: "Solicitação duplicada" },
  { value: "incorrect_data", label: "Dados incorretos" },
  { value: "deadline_passed", label: "Prazo para alteração encerrado" },
  { value: "other", label: "Outro" },
] as const;

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Dialog({ title, open, close, children }: { title: string; open: boolean; close: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}>
      <div className="w-full max-w-lg rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          <button type="button" onClick={close} aria-label="Fechar" className="rounded-lg border border-slate-700 px-3 py-1 text-slate-300">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ReviewDialog({ request, close, onResolved }: { request: PendingChangeRequestRow; close: () => void; onResolved: (id: string) => void }) {
  const [mode, setMode] = useState<"view" | "reject">("view");
  const [reasonCode, setReasonCode] = useState<(typeof REJECT_REASON_OPTIONS)[number]["value"] | "">("");
  const [reasonText, setReasonText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const outOfStock = request.stock.tracked && request.stock.available !== null && request.stock.available <= 0;

  function submitDecision(decision: "approved" | "rejected", notes: string | null) {
    setError(null);
    startTransition(async () => {
      const form = new FormData();
      form.set("request_id", request.id);
      form.set("decision", decision);
      form.set("ticket_id", request.ticketId);
      if (notes) form.set("notes", notes);
      const result = await reviewTicketItemChangeAction(form);
      if (!result.success) {
        setError(result.message ?? "Não foi possível concluir a revisão.");
        return;
      }
      onResolved(request.id);
      router.refresh();
      close();
    });
  }

  function submitReject() {
    if (!reasonCode) { setError("Selecione um motivo."); return; }
    if (reasonCode === "other" && !reasonText.trim()) { setError('Descreva o motivo quando selecionar "Outro".'); return; }
    const label = REJECT_REASON_OPTIONS.find((option) => option.value === reasonCode)?.label ?? "";
    const notes = reasonCode === "other" ? reasonText.trim() : (reasonText.trim() ? `${label} — ${reasonText.trim()}` : label);
    submitDecision("rejected", notes);
  }

  return (
    <Dialog title="Solicitação de alteração" open close={close}>
      <div className="mt-4 space-y-4">
        <div className="space-y-1.5 rounded-2xl border border-slate-800 bg-slate-950/50 p-4 text-sm">
          <p><span className="text-slate-400">Item: </span><strong className="text-slate-100">{request.kitItemName}</strong></p>
          <p><span className="text-slate-400">Titular: </span><strong className="text-slate-100">{request.holderName}</strong></p>
          <p><span className="text-slate-400">Ingresso: </span><strong className="text-slate-100">{request.ticketReference}</strong></p>
          <p><span className="text-slate-400">Evento: </span><strong className="text-slate-100">{request.eventName}</strong></p>
          <p><span className="text-slate-400">Atual: </span><strong className="text-slate-100">{request.currentLabel}</strong></p>
          <p><span className="text-slate-400">Solicitado: </span><strong className="text-emerald-300">{request.requestedLabel}</strong></p>
          <p>
            <span className="text-slate-400">Estoque atual de {request.requestedLabel}: </span>
            <strong className={outOfStock ? "text-rose-300" : "text-slate-100"}>
              {request.stock.tracked ? `${request.stock.available ?? 0} unidade(s)` : "Sob demanda (sem limite de estoque)"}
            </strong>
          </p>
          {request.reason ? <p className="pt-1 text-xs text-slate-500">Motivo do participante: {request.reason}</p> : null}
        </div>

        {outOfStock ? (
          <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            Não há estoque disponível para {request.requestedLabel}. Não é possível aprovar esta solicitação — rejeite-a ou aguarde entrada de estoque.
          </p>
        ) : null}

        {mode === "reject" ? (
          <div className="space-y-3 rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4">
            <label className="block space-y-1">
              <span className="text-xs text-slate-300">Motivo da rejeição</span>
              <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as typeof reasonCode)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100">
                <option value="">Selecione</option>
                {REJECT_REASON_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            {reasonCode === "other" || reasonCode ? (
              <label className="block space-y-1">
                <span className="text-xs text-slate-300">{reasonCode === "other" ? "Descreva o motivo" : "Observações (opcional)"}</span>
                <textarea value={reasonText} onChange={(event) => setReasonText(event.target.value)} rows={2} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100" />
              </label>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="text-sm text-rose-300" role="alert">{error}</p> : null}

        <div className="flex flex-wrap justify-end gap-2">
          {mode === "reject" ? (
            <>
              <button type="button" onClick={() => { setMode("view"); setError(null); }} disabled={pending} className="h-10 rounded-xl border border-slate-700 px-4 text-sm text-slate-300 disabled:opacity-50">Voltar</button>
              <button type="button" onClick={submitReject} disabled={pending} className="h-10 rounded-xl bg-rose-500 px-4 text-sm font-semibold text-rose-950 disabled:opacity-50">
                {pending ? "Enviando..." : "Confirmar rejeição"}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setMode("reject")} disabled={pending} className="h-10 rounded-xl border border-rose-500/40 px-4 text-sm text-rose-200 disabled:opacity-50">Rejeitar</button>
              <button type="button" onClick={() => submitDecision("approved", null)} disabled={pending || outOfStock} className="h-10 rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-emerald-950 disabled:opacity-50">
                {pending ? "Aprovando..." : "Aprovar alteração"}
              </button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export function SolicitacoesClient({ initialRequests }: { initialRequests: PendingChangeRequestRow[] }) {
  const [requests, setRequests] = useState(initialRequests);
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [reviewing, setReviewing] = useState<PendingChangeRequestRow | null>(null);

  const events = useMemo(() => {
    const map = new Map<string, string>();
    for (const request of initialRequests) map.set(request.eventId, request.eventName);
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [initialRequests]);

  const visibleRequests = eventFilter === "all" ? requests : requests.filter((request) => request.eventId === eventFilter);

  function handleResolved(id: string) {
    setRequests((prev) => prev.filter((request) => request.id !== id));
  }

  return (
    <div className="space-y-4">
      {events.length > 1 ? (
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400" htmlFor="event-filter">Evento</label>
          <select id="event-filter" value={eventFilter} onChange={(event) => setEventFilter(event.target.value)} className="h-10 rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100">
            <option value="all">Todos os eventos</option>
            {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
          </select>
        </div>
      ) : null}

      {visibleRequests.length === 0 ? (
        <AdminEmptyState title="Nenhuma solicitação pendente" description="Quando um participante pedir alteração de um item do kit (ex.: tamanho de camiseta) na Minha Conta, a solicitação aparece aqui para revisão." />
      ) : (
        <div className="grid gap-3">
          {visibleRequests.map((request) => (
            <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="min-w-0">
                <p className="font-semibold text-slate-100">{request.holderName}</p>
                <p className="mt-0.5 text-sm text-slate-400">{request.kitItemName} · {request.currentLabel} → <span className="text-emerald-300">{request.requestedLabel}</span></p>
                <p className="mt-1 text-xs text-slate-500">{request.eventName} · Solicitado em {formatDateTime(request.requestedAt)}</p>
              </div>
              <button type="button" onClick={() => setReviewing(request)} className="h-10 shrink-0 rounded-xl border border-emerald-500/40 px-4 text-sm font-medium text-emerald-200">
                Revisar
              </button>
            </div>
          ))}
        </div>
      )}

      {reviewing ? <ReviewDialog request={reviewing} close={() => setReviewing(null)} onResolved={handleResolved} /> : null}
    </div>
  );
}
