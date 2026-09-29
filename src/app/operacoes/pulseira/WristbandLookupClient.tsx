"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { AppBreadcrumb } from "@/components/navigation/AppBreadcrumb";
import { checkinStatusChip } from "@/components/militrin/status-chips";
import { isOperationalTicketStatus } from "@/lib/dashboard/operational-shirt-demand";
import { getStatusLabel } from "@/lib/status-labels";
import { formatEventDateTimeWithSeconds } from "@/lib/utils/date";
import { QrScanner } from "../components/QrScanner";
import { ReplaceWristbandDialog } from "../components/ReplaceWristbandDialog";
import { lookupWristbandByQrAction, replaceWristbandAction, searchLinkedWristbandsAction, unlinkWristbandAction } from "../actions";

type LookupResult = Awaited<ReturnType<typeof lookupWristbandByQrAction>>;
type LinkedWristbandsResult = Awaited<ReturnType<typeof searchLinkedWristbandsAction>>;
type LinkedWristbandRow = LinkedWristbandsResult extends { rows: infer R } ? R extends Array<infer Item> ? Item : never : never;
type LinkedTicket = Extract<LookupResult, { success: true; state: "linked" }> extends { ticket: infer T } ? T : never;

const SCAN_ANOTHER_LABEL = "Ler outra pulseira";
const UNKNOWN_OPERATOR_LABEL = "Operador não identificado";

function formatDateTime(value: string | null) {
  if (!value) return null;
  return formatEventDateTimeWithSeconds(value);
}

function maskCpf(cpf: string) {
  const digits = cpf.replace(/\D/g, "");
  if (digits.length < 5) return "Não informado";
  return `***.***.***-${digits.slice(-2)}`;
}

function humanTicketStatus(status: string | null | undefined) {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "used") return checkinStatusChip(true).label;
  return getStatusLabel(status, "Não informado");
}

const PAGE_SIZE = 30;

function LinkedWristbandsSection({
  events,
  canUnlink,
  canViewTicket,
}: {
  events: Array<{ id: string; name: string }>;
  canUnlink: boolean;
  canViewTicket: boolean;
}) {
  const [eventId, setEventId] = useState(events[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LinkedWristbandRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  const [trackedFilters, setTrackedFilters] = useState({ eventId, query });
  if (trackedFilters.eventId !== eventId || trackedFilters.query !== query) {
    setTrackedFilters({ eventId, query });
    setPage(1);
  }

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setLoading(true);
      void searchLinkedWristbandsAction({ eventId, query, page, pageSize: PAGE_SIZE }).then((response) => {
        if (cancelled) return;
        setLoading(false);
        if (!response.success) {
          setMessage(response.message ?? "Não foi possível carregar as pulseiras vinculadas.");
          setRows([]);
          setTotal(0);
          return;
        }
        setMessage(null);
        setRows(response.rows);
        setTotal(response.total);
      });
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [eventId, query, page]);

  async function handleUnlink(row: LinkedWristbandRow) {
    if (!window.confirm(`Desvincular a pulseira ${row.code} de ${row.participant_name}?`)) return;
    setUnlinkingId(row.wristband_id);
    const response = await unlinkWristbandAction({ ticket_id: row.ticket_id, reason: "Desvinculada pela lista de pulseiras vinculadas" });
    setUnlinkingId(null);
    if (!response.success) {
      setMessage(response.message ?? "Não foi possível desvincular a pulseira.");
      return;
    }
    setRows((current) => current.filter((item) => item.wristband_id !== row.wristband_id));
    setTotal((current) => Math.max(0, current - 1));
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <SectionCard title="Pulseiras vinculadas" description="Consulte quem está com pulseira vinculada agora e desvincule diretamente pela lista, se precisar.">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Evento</span>
          <select value={eventId} onChange={(event) => setEventId(event.target.value)} className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm">
            {events.map((event) => (
              <option key={event.id} value={event.id}>{event.name}</option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1 space-y-1 text-sm">
          <span className="text-slate-300">Pesquisar por nome, CPF, PIN ou pulseira</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Pesquisar por nome, CPF ou pulseira..."
            className="h-10 w-full max-w-md rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm"
          />
        </label>
      </div>

      {message ? <p className="mt-3 text-sm text-rose-300" role="alert">{message}</p> : null}

      <div className="mt-4">
        {loading ? (
          <p className="py-6 text-center text-sm text-slate-400">Carregando...</p>
        ) : rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-700 py-8 text-center text-sm text-slate-400">
            {eventId ? "Nenhuma pulseira vinculada encontrada." : "Selecione um evento."}
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.wristband_id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-100">{row.participant_name}</p>
                    <p className="text-xs text-slate-400">
                      {maskCpf(row.participant_cpf)} · Pulseira {row.code} · Ingresso {row.ticket_reference}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Comprador: {row.buyer_name}
                      {row.registration_contact_pin ? ` · PIN ${row.registration_contact_pin}` : ""}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {row.checkin_done ? "Check-in realizado" : "Check-in pendente"}
                      {row.linked_at ? ` · vinculada em ${formatDateTime(row.linked_at)}` : ""}
                      {row.linked_by_name ? ` · por ${row.linked_by_name}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {canViewTicket ? (
                      <Link href={`/ingressos/${row.ticket_id}`} className="inline-flex h-8 items-center rounded-lg border border-cyan-500/40 px-2.5 text-xs text-cyan-200">
                        Abrir ingresso
                      </Link>
                    ) : null}
                    {canUnlink ? (
                      <button
                        type="button"
                        disabled={unlinkingId === row.wristband_id}
                        onClick={() => void handleUnlink(row)}
                        className="inline-flex h-8 items-center rounded-lg border border-rose-500/40 px-2.5 text-xs text-rose-200 disabled:opacity-40"
                      >
                        {unlinkingId === row.wristband_id ? "Desvinculando..." : "Desvincular"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {total > PAGE_SIZE ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} className="rounded-lg border border-slate-700 px-3 py-1.5 disabled:opacity-40">
            Anterior
          </button>
          <span className="text-slate-400">Página {page} de {totalPages} · {total} pulseira(s)</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)} className="rounded-lg border border-slate-700 px-3 py-1.5 disabled:opacity-40">
            Próxima
          </button>
        </div>
      ) : null}
    </SectionCard>
  );
}

export function WristbandLookupClient({
  events,
  canUnlink,
  canReplace,
  canViewTicket,
}: {
  events: Array<{ id: string; name: string }>;
  canUnlink: boolean;
  canReplace: boolean;
  canViewTicket: boolean;
}) {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [scannerKey, setScannerKey] = useState(0);

  async function handleRead(value: string) {
    setLoading(true);
    try {
      const response = await lookupWristbandByQrAction(value);
      setResult(response);
    } catch (error) {
      setResult({ success: false, message: error instanceof Error ? error.message : "Falha inesperada." });
    } finally {
      setLoading(false);
    }
  }

  function handleScanAnother() {
    setResult(null);
    setScannerKey((key) => key + 1);
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-6 lg:flex-row">
        <Sidebar />

        <div className="min-w-0 flex-1 space-y-6">
          <header className="space-y-4 rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10">
            <AppBreadcrumb
              items={[{ label: "Início", href: "/painel" }, { label: "Central de Operações", href: "/operacoes" }, { label: "Ver pulseira vinculada" }]}
              backHref="/operacoes"
            />
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-emerald-400">Consulta rápida por QR</p>
              <h1 className="text-2xl font-semibold text-white">Ver pulseira vinculada</h1>
            </div>
          </header>

          <section className="overflow-x-hidden rounded-3xl border border-slate-800/80 bg-slate-900/70 p-4 sm:p-5">
            {!result ? (
              <div>
                <p className="text-lg font-semibold text-white">Escaneie a pulseira</p>
                <p className="mt-1 text-sm text-slate-400">Aponte a câmera para o QR/código da pulseira para consultar o vínculo atual.</p>
                <div className={`relative mt-3 ${loading ? "pointer-events-none opacity-60" : ""}`}>
                  <QrScanner
                    key={scannerKey}
                    title="Escaneie a pulseira"
                    onRead={handleRead}
                    square
                    hideManual
                    guideLabel="Aproxime a pulseira até o QR ocupar boa parte da área"
                    helpMessage="Aproxime a pulseira da câmera e evite reflexos."
                  />
                </div>
              </div>
            ) : (
              <WristbandResultCard
                result={result}
                canReplace={canReplace}
                canViewTicket={canViewTicket}
                busy={loading}
                onScanAnother={handleScanAnother}
                onReplaced={async (newCode) => {
                  const refreshed = await lookupWristbandByQrAction(newCode);
                  setResult(refreshed);
                }}
              />
            )}
            {loading ? <p className="mt-3 text-sm text-slate-400">Consultando...</p> : null}
          </section>

          {events.length > 0 ? <LinkedWristbandsSection events={events} canUnlink={canUnlink} canViewTicket={canViewTicket} /> : null}
        </div>
      </div>
    </main>
  );
}

function WristbandResultCard({
  result,
  canReplace,
  canViewTicket,
  busy,
  onScanAnother,
  onReplaced,
}: {
  result: LookupResult;
  canReplace: boolean;
  canViewTicket: boolean;
  busy: boolean;
  onScanAnother: () => void;
  onReplaced: (newCode: string) => Promise<void>;
}) {
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const linked = result.success && result.state === "linked" ? result : null;
  const ticketId = linked && "ticket_id" in linked ? linked.ticket_id : null;
  const ticket = linked && "ticket" in linked ? linked.ticket : null;
  const ticketEligible = !ticket || isOperationalTicketStatus(ticket.ticket_status);
  const showOpenTicket = Boolean(linked && ticketId && canViewTicket);
  const showReplace = Boolean(linked && ticketId && canReplace && ticketEligible);

  return (
    <div className="rounded-3xl border border-slate-700 bg-slate-900 p-6">
      {!result.success ? (
        <div>
          <p className="text-lg font-bold text-rose-300">QR não reconhecido</p>
          <p className="mt-1 text-sm text-slate-400">{result.message}</p>
          <p className="mt-1 text-sm text-slate-400">Pulseira ainda não vinculada.</p>
        </div>
      ) : null}

      {result.success && result.state === "unlinked" ? (
        <div>
          <p className="text-lg font-bold text-amber-300">Pulseira desvinculada</p>
          <p className="mt-1 text-sm text-slate-400">Pulseira desvinculada e disponível para novo vínculo.</p>
          <div className="mt-4">
            <Field label="Código" value={result.wristband.code} />
          </div>
        </div>
      ) : null}

      {linked ? (
        <ActiveCard
          code={linked.wristband.code}
          status={linked.wristband.status}
          linkedAt={linked.wristband.linked_at}
          linkedByName={linked.wristband.linked_by_name}
          ticket={ticket}
        />
      ) : null}

      {actionError ? <p className="mt-3 text-sm text-rose-300" role="alert">{actionError}</p> : null}

      <div className="mt-6 space-y-2">
        {showOpenTicket || showReplace ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            {showOpenTicket && ticketId ? (
              <Link
                href={`/ingressos/${ticketId}`}
                className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-cyan-500 px-4 text-sm font-semibold text-cyan-950 sm:flex-1"
              >
                Abrir ingresso
              </Link>
            ) : null}
            {showReplace ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setReplaceOpen(true)}
                className="min-h-12 w-full rounded-2xl border border-cyan-500/40 px-4 text-sm font-semibold text-cyan-200 disabled:opacity-40 sm:flex-1"
              >
                Substituir pulseira
              </button>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          onClick={onScanAnother}
          disabled={busy}
          className="min-h-12 w-full rounded-2xl border border-slate-600 px-4 text-sm font-semibold text-slate-300 disabled:opacity-55"
        >
          {SCAN_ANOTHER_LABEL}
        </button>
        <Link href="/operacoes" className="inline-flex min-h-11 w-full items-center justify-center rounded-2xl border border-slate-700 px-4 text-sm text-slate-300">
          Fechar / voltar
        </Link>
      </div>

      {replaceOpen && linked && ticketId ? (
        <ReplaceWristbandDialog
          currentCode={linked.wristband.code}
          onClose={() => setReplaceOpen(false)}
          onSubmit={async (payload) => {
            const response = await replaceWristbandAction({
              ticket_id: ticketId,
              new_code: payload.newCode,
              reason_code: payload.reasonCode,
              reason_text: payload.reasonText,
            });
            if (!response.success) {
              setActionError(response.message ?? "Não foi possível substituir a pulseira.");
              return response;
            }
            setActionError(null);
            setReplaceOpen(false);
            await onReplaced(response.code ?? payload.newCode);
            return response;
          }}
        />
      ) : null}
    </div>
  );
}

function ActiveCard({
  code,
  status,
  linkedAt,
  linkedByName,
  ticket,
}: {
  code: string;
  status: string;
  linkedAt: string | null;
  linkedByName: string;
  ticket: LinkedTicket | null | undefined;
}) {
  const linkedAtLabel = formatDateTime(linkedAt);
  const operatorLabel = String(linkedByName ?? "").trim() || UNKNOWN_OPERATOR_LABEL;
  const buyerName = String(ticket?.buyer_name ?? "").trim();
  const buyerUnidentified = !buyerName || buyerName === "Comprador não identificado";
  return (
    <div className="space-y-3">
      <div>
        <p className="text-lg font-bold text-emerald-300">Pulseira vinculada</p>
        <p className="mt-1 font-mono text-3xl font-black tracking-tight text-white">{code}</p>
        <p className="mt-2 text-sm font-semibold text-slate-200">{status === "active" ? "Ativa" : status}</p>
        {linkedAtLabel ? <p className="text-sm text-slate-400">Vinculada em {linkedAtLabel}</p> : null}
        <p className="text-sm text-slate-400">Vinculada por {operatorLabel}</p>
      </div>
      {ticket ? (
        <>
          <Field label="Titular" value={ticket.holder_name || "Titular não definido"} />
          <Field label="Evento" value={ticket.event_name || "Não informado"} />
          <Field label="Categoria" value={ticket.category_name || "Não informado"} />
          <Field label="Status do ingresso" value={humanTicketStatus(ticket.ticket_status)} />
          {buyerUnidentified ? (
            <p className="px-1 text-sm text-slate-600">Comprador não identificado</p>
          ) : (
            <p className="px-1 text-sm text-slate-500">Comprador: {buyerName}</p>
          )}
        </>
      ) : (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Pulseira encontrada, mas você não tem permissão para ver os dados do ingresso vinculado.
        </p>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="font-semibold text-slate-100">{value}</p>
    </div>
  );
}
