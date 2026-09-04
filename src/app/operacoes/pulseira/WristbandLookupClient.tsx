"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { AppBreadcrumb } from "@/components/navigation/AppBreadcrumb";
import { QrScanner } from "../components/QrScanner";
import { lookupWristbandByQrAction, searchLinkedWristbandsAction, unlinkWristbandAction } from "../actions";

type LookupResult = Awaited<ReturnType<typeof lookupWristbandByQrAction>>;
type LinkedWristbandsResult = Awaited<ReturnType<typeof searchLinkedWristbandsAction>>;
type LinkedWristbandRow = LinkedWristbandsResult extends { rows: infer R } ? R extends Array<infer Item> ? Item : never : never;

function formatDateTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("pt-BR");
}

function maskCpf(cpf: string) {
  const digits = cpf.replace(/\D/g, "");
  if (digits.length < 5) return "Não informado";
  return `***.***.***-${digits.slice(-2)}`;
}

const PAGE_SIZE = 30;

function LinkedWristbandsSection({ events, canUnlink }: { events: Array<{ id: string; name: string }>; canUnlink: boolean }) {
  const [eventId, setEventId] = useState(events[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LinkedWristbandRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  // Reset de pagina ao trocar evento/busca ajustado DURANTE o render (nao num
  // useEffect) -- e o padrao recomendado pra "resetar estado quando uma prop
  // muda" (evita o cascading render que useEffect+setState causaria aqui).
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
                    <Link href={`/ingressos/${row.ticket_id}`} className="inline-flex h-8 items-center rounded-lg border border-cyan-500/40 px-2.5 text-xs text-cyan-200">
                      Abrir ingresso
                    </Link>
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

export function WristbandLookupClient({ events, canUnlink }: { events: Array<{ id: string; name: string }>; canUnlink: boolean }) {
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

          <SectionCard
            title="Escaneie a pulseira"
            description="Aponte a câmera para o QR/código da pulseira para consultar o vínculo atual."
          >
            {!result ? (
              <QrScanner
                key={scannerKey}
                title="Escaneie a pulseira"
                onRead={handleRead}
                guideLabel="Aproxime a pulseira até o QR ocupar boa parte da área"
                helpMessage="Aproxime a pulseira da câmera e evite reflexos."
              />
            ) : (
              <WristbandResultCard result={result} onScanAnother={handleScanAnother} />
            )}
            {loading ? <p className="mt-3 text-sm text-slate-400">Consultando...</p> : null}
          </SectionCard>

          {events.length > 0 ? <LinkedWristbandsSection events={events} canUnlink={canUnlink} /> : null}
        </div>
      </div>
    </main>
  );
}

function WristbandResultCard({ result, onScanAnother }: { result: LookupResult; onScanAnother: () => void }) {
  return (
    <div className="rounded-3xl border border-slate-700 bg-slate-900 p-6">
      {/* QR invalido/nao reconhecido -- inclui, de proposito, codigo de
          outra organizacao (RLS ja filtra antes de chegar aqui, entao nunca
          da pra distinguir "nao existe" de "existe em outra org"). */}
      {!result.success ? (
        <div>
          <p className="text-lg font-bold text-rose-300">QR não reconhecido</p>
          <p className="mt-1 text-sm text-slate-400">{result.message}</p>
          <p className="mt-1 text-sm text-slate-400">Pulseira ainda não vinculada.</p>
        </div>
      ) : null}

      {/* Pulseira com registro, mas o vinculo mais recente NAO esta ativo
          (desvinculada/substituida/bloqueada) -- nunca mostra dados de
          ingresso antigos como se ainda valessem. */}
      {result.success && result.state === "unlinked" ? (
        <div>
          <p className="text-lg font-bold text-amber-300">Pulseira desvinculada</p>
          <p className="mt-1 text-sm text-slate-400">Pulseira desvinculada e disponível para novo vínculo.</p>
          <div className="mt-4">
            <Field label="Código" value={result.wristband.code} />
          </div>
        </div>
      ) : null}

      {result.success && result.state === "linked" ? (
        <div className="space-y-4">
          <div>
            <p className="text-lg font-bold text-emerald-300">Pulseira vinculada</p>
            <p className="text-xs uppercase tracking-wide text-slate-500">Pulseira</p>
            <p className="text-2xl font-black">{result.wristband.code}</p>
            <p className="text-sm text-slate-400">
              Status: {result.wristband.status}
              {result.wristband.linked_at ? ` · vinculada em ${formatDateTime(result.wristband.linked_at)}` : ""}
            </p>
          </div>

          {result.ticket ? (
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Field label="Comprador" value={result.ticket.buyer_name} />
              <Field label="Titular do ingresso" value={result.ticket.holder_name} />
              <Field label="Evento" value={result.ticket.event_name} />
              <Field label="Categoria" value={result.ticket.category_name} />
              <Field label="Status do ingresso" value={result.ticket.ticket_status} />
            </div>
          ) : (
            <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              Pulseira encontrada, mas você não tem permissão para ver os dados do ingresso vinculado.
            </p>
          )}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onScanAnother}
          className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950"
        >
          Ler outra pulseira
        </button>
        <Link href="/operacoes" className="rounded-xl border border-slate-700 px-4 py-2 text-sm">
          Fechar / voltar
        </Link>
      </div>
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
