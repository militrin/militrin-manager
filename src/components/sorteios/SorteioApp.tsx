"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  AtSign,
  Download,
  ExternalLink,
  FileSpreadsheet,
  History as HistoryIcon,
  ListChecks,
  RotateCcw,
  Share2,
  ShieldQuestion,
  Sparkles,
  Trophy,
  Upload,
  Users,
} from "lucide-react";
import { AdminActivityTimeline, type AdminTimelineItem } from "@/components/admin/AdminActivityTimeline";
import { AdminEmptyState, AdminSection, AdminStatCard } from "@/components/admin";
import { parseSorteioCsv, type CsvImportSummary } from "./csv";
import { pickSecureRandomEntry } from "./random";
import { archiveSession, createEmptySession, loadArchivedSessions, loadSession, makeHistoryEventId, saveSession } from "./storage";
import { RouletteAnimation } from "./RouletteAnimation";
import { RulesDialog } from "./RulesDialog";
import { DisqualifyModal } from "./DisqualifyModal";
import { StrongConfirmModal } from "./StrongConfirmModal";
import { ParticipationsTable } from "./ParticipationsTable";
import { TransparencyPanel } from "./TransparencyPanel";
import { downloadComprovantePdf } from "./pdf";
import { downloadShareImage } from "./share-image";
import { InstagramImport } from "./InstagramImport";
import { persistGiveawaySession, type InstagramIntegrationStatus } from "@/app/sorteios/actions";
import {
  EMPTY_CHECKLIST,
  INSTAGRAM_HANDLE,
  INSTAGRAM_POST_URL,
  type ArchivedSession,
  type DisqualificationReason,
  type HistoryEventType,
  type ParticipationEntry,
  type SorteioSession,
  type ValidationChecklistState,
} from "./types";

type Tab = "sorteio" | "participacoes" | "transparencia";

function historyEvent(type: HistoryEventType, message: string, detail?: string) {
  return { id: makeHistoryEventId(), timestamp: new Date().toISOString(), type, message, detail };
}

function formatDateTime(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("pt-BR");
}

export function SorteioApp({ initialSession = null, persistenceAvailable = true, initialInstagramStatus }: { initialSession?: SorteioSession | null; persistenceAvailable?: boolean; initialInstagramStatus: InstagramIntegrationStatus }) {
  const [session, setSession] = useState<SorteioSession | null>(null);
  const [archived, setArchived] = useState<ArchivedSession[]>([]);
  const [tab, setTab] = useState<Tab>("sorteio");
  const [importSummary, setImportSummary] = useState<CsvImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [drawAttempt, setDrawAttempt] = useState(0);
  const [drawPool, setDrawPool] = useState<ParticipationEntry[]>([]);
  const [showRules, setShowRules] = useState(false);
  const [showDisqualify, setShowDisqualify] = useState(false);
  const [showConfirmWinner, setShowConfirmWinner] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const persistenceQueue = useRef<Promise<void>>(Promise.resolve());
  const databaseIdRef = useRef<string | null>(initialSession?.databaseId ?? null);
  const autosaveTimerRef = useRef<number | null>(null);
  const criticalPendingRef = useRef(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [criticalPending, setCriticalPending] = useState(false);

  useEffect(() => {
    // Leitura do localStorage é síncrona, mas adiada para o próximo microtask
    // para não disparar setState diretamente no corpo do efeito de montagem.
    queueMicrotask(() => {
      const loaded = initialSession ?? loadSession();
      databaseIdRef.current = loaded.databaseId;
      setSession(loaded);
      setArchived(loadArchivedSessions());
    });
  }, [initialSession]);

  useEffect(() => {
    if (session) saveSession(session);
  }, [session]);

  const persistQueued = useCallback((candidate: SorteioSession) => {
    let resolved!: SorteioSession;
    const operation = persistenceQueue.current.catch(() => undefined).then(async () => {
      const prepared = { ...candidate, databaseId: databaseIdRef.current ?? candidate.databaseId };
      const result = await persistGiveawaySession(prepared);
      databaseIdRef.current = result.databaseId;
      resolved = { ...prepared, databaseId: result.databaseId, snapshotFrozenAt: result.snapshotFrozenAt };
    });
    persistenceQueue.current = operation.catch(() => undefined);
    return operation.then(() => resolved);
  }, []);

  useEffect(() => {
    if (!persistenceAvailable || !session || session.entries.length === 0) return;
    autosaveTimerRef.current = window.setTimeout(async () => {
      try {
        const persisted = await persistQueued(session);
        setPersistenceError(null);
        if (session.databaseId !== persisted.databaseId || session.snapshotFrozenAt !== persisted.snapshotFrozenAt) {
          setSession((current) => current ? { ...current, databaseId: persisted.databaseId, snapshotFrozenAt: persisted.snapshotFrozenAt } : current);
        }
      } catch (value) {
        setPersistenceError(value instanceof Error ? value.message : "Falha ao persistir o sorteio.");
      }
    }, 350);
    return () => {
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    };
  }, [persistQueued, persistenceAvailable, session]);

  const updateSession = useCallback((updater: (prev: SorteioSession) => SorteioSession) => {
    setSession((prev) => (prev ? updater(prev) : prev));
  }, []);

  if (!session) {
    return <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">Carregando sorteio…</div>;
  }
  const currentSession = session;

  const isCsvLocked = session.snapshotFrozenAt !== null || (session.status !== "empty" && session.status !== "ready");
  const uniqueParticipants = new Set(session.entries.map((e) => e.username.toLowerCase())).size;
  const activePool = session.entries.filter((e) => e.status === "active");
  const winnerEntry = session.entries.find((e) => e.commentId === session.currentWinnerCommentId) ?? null;
  const confirmedWinnerEntry = session.entries.find((e) => e.commentId === session.confirmedWinner?.commentId) ?? null;
  const checklistComplete = Object.values(session.currentChecklist).every(Boolean);
  const noEligibleParticipants = session.entries.length > 0 && activePool.length === 0;

  function processFile(file: File) {
    setImportError(null);
    setImportSummary(null);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const result = parseSorteioCsv(text);
      if (!result.success) {
        setImportError(result.error);
        return;
      }
      setImportSummary(result.summary);
      updateSession((prev) => ({
        ...prev,
        entries: result.entries,
        source: "csv",
        instagramMediaId: null,
        instagramMediaPermalink: null,
        instagramIntegrationId: null,
        snapshotFrozenAt: null,
        importedFileName: file.name,
        importedAt: new Date().toISOString(),
        status: "ready",
        currentWinnerCommentId: null,
        currentDrawAt: null,
        currentChecklist: { ...EMPTY_CHECKLIST },
        disqualifications: [],
        confirmedWinner: null,
        history: [
          ...prev.history,
          historyEvent(
            "import",
            "Arquivo importado",
            `${file.name} · ${result.summary.imported} comentários carregados`,
          ),
        ],
      }));
    };
    reader.readAsText(file, "utf-8");
  }

  function handleInstagramImported(value: { entries: ParticipationEntry[]; mediaId: string; permalink: string; integrationId: string; syncedAt: string }) {
    setImportError(null);
    setImportSummary(null);
    updateSession((prev) => ({
      ...prev,
      entries: value.entries,
      source: "instagram",
      instagramMediaId: value.mediaId,
      instagramMediaPermalink: value.permalink,
      instagramIntegrationId: value.integrationId,
      importedFileName: null,
      importedAt: value.syncedAt,
      snapshotFrozenAt: null,
      status: "ready",
      currentWinnerCommentId: null,
      currentDrawAt: null,
      currentChecklist: { ...EMPTY_CHECKLIST },
      disqualifications: [],
      confirmedWinner: null,
      history: [...prev.history, historyEvent("import", "Comentários sincronizados pela API oficial da Meta", `${value.entries.length} comentários · mídia ${value.mediaId}`)],
    }));
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  }

  async function persistCritical(candidate: SorteioSession) {
    if (!persistenceAvailable) {
      setPersistenceError(null);
      setSession(candidate);
      return candidate;
    }
    if (criticalPendingRef.current) return null;
    if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
    criticalPendingRef.current = true;
    setCriticalPending(true);
    setPersistenceError(null);
    try {
      const persisted = await persistQueued(candidate);
      setSession(persisted);
      return persisted;
    } catch (value) {
      setPersistenceError(value instanceof Error ? value.message : "Falha ao persistir a operacao critica.");
      return null;
    } finally {
      criticalPendingRef.current = false;
      setCriticalPending(false);
    }
  }

  async function startDraw(kind: "draw_started" | "redraw_started", pool: ParticipationEntry[], base: SorteioSession = currentSession) {
    const winner = pickSecureRandomEntry(pool);
    const candidate: SorteioSession = {
      ...base,
      status: "drawing",
      currentWinnerCommentId: winner.commentId,
      currentDrawAt: new Date().toISOString(),
      currentChecklist: { ...EMPTY_CHECKLIST },
      history: [
        ...base.history,
        historyEvent(kind, kind === "draw_started" ? "Sorteio iniciado" : "Novo sorteio iniciado"),
      ],
    };
    if (!await persistCritical(candidate)) return;
    setDrawPool(pool);
    setDrawAttempt((n) => n + 1);
  }

  async function handleDrawClick() {
    if (currentSession.status !== "ready" || activePool.length === 0 || criticalPending) return;
    await startDraw("draw_started", activePool);
  }

  async function handleAnimationComplete() {
    const winner = currentSession.entries.find((entry) => entry.commentId === currentSession.currentWinnerCommentId);
    await persistCritical({ ...currentSession, status: "awaiting_validation", history: [...currentSession.history, historyEvent("winner_selected", `@${winner?.username ?? "?"} selecionado(a)`)] });
  }

  function handleChecklistToggle(key: keyof ValidationChecklistState) {
    updateSession((prev) => ({ ...prev, currentChecklist: { ...prev.currentChecklist, [key]: !prev.currentChecklist[key] } }));
  }

  async function handleDisqualifyConfirm(reason: DisqualificationReason, reasonLabel: string, otherDetail?: string) {
    if (!winnerEntry) return;
    const entries = currentSession.entries.map((e) =>
        e.commentId === winnerEntry.commentId ? { ...e, status: "disqualified" as const } : e,
      );
    const candidate: SorteioSession = {
        ...currentSession,
        entries,
        currentWinnerCommentId: null,
        currentChecklist: { ...EMPTY_CHECKLIST },
        status: "ready",
        disqualifications: [
          ...currentSession.disqualifications,
          {
            id: makeHistoryEventId(),
            commentId: winnerEntry.commentId,
            username: winnerEntry.username,
            comment: winnerEntry.comment,
            reason,
            reasonLabel,
            otherDetail,
            disqualifiedAt: new Date().toISOString(),
          },
        ],
        history: [
          ...currentSession.history,
          historyEvent(
            "disqualified",
            "Participante desclassificado",
            `@${winnerEntry.username} · Motivo: ${reasonLabel}${otherDetail ? ` — ${otherDetail}` : ""}`,
          ),
        ],
      };
    const persisted = await persistCritical(candidate);
    if (!persisted) return;
    setShowDisqualify(false);

    const remainingPool = entries.filter((entry) => entry.status === "active");
    if (remainingPool.length > 0) {
      await startDraw("redraw_started", remainingPool, persisted);
    }
  }

  async function handleConfirmWinnerFinal() {
    const candidate: SorteioSession = {
      ...currentSession,
      status: "finalized",
      confirmedWinner: currentSession.currentWinnerCommentId
        ? { commentId: currentSession.currentWinnerCommentId, confirmedAt: new Date().toISOString() }
        : null,
      history: [
        ...currentSession.history,
        historyEvent("winner_confirmed", `Ganhador confirmado: @${winnerEntry?.username ?? "?"}`),
      ],
    };
    if (await persistCritical(candidate)) setShowConfirmWinner(false);
  }

  function handleResetConfirmed() {
    setShowResetConfirm(false);
    archiveSession(session!);
    setArchived(loadArchivedSessions());
    databaseIdRef.current = null;
    setSession(createEmptySession());
    setImportSummary(null);
    setImportError(null);
    setTab("sorteio");
  }

  const timelineItems: AdminTimelineItem[] = session.history
    .slice()
    .reverse()
    .map((h) => ({
      id: h.id,
      title: h.message,
      description: h.detail,
      date: new Date(h.timestamp).toLocaleTimeString("pt-BR"),
    }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4">
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <AtSign size={16} className="text-emerald-300" />
          <span className="font-medium text-white">{INSTAGRAM_HANDLE}</span>
          <a
            href={INSTAGRAM_POST_URL}
            target="_blank"
            rel="noreferrer"
            className="ml-2 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-emerald-300"
          >
            Ver post oficial <ExternalLink size={12} />
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowRules(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs font-medium text-slate-200 hover:border-emerald-400/50 hover:text-emerald-200"
          >
            <ListChecks size={14} /> REGRAS DO SORTEIO
          </button>
          <button
            type="button"
            disabled={session.status === "empty" || criticalPending}
            onClick={() => setShowResetConfirm(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw size={14} /> RESETAR SORTEIO
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-2">
        {([
          ["sorteio", "Sorteio"],
          ["participacoes", "Participações"],
          ["transparencia", "Transparência"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-xl px-3.5 py-2 text-sm font-medium transition ${
              tab === key ? "bg-emerald-500/15 text-emerald-300" : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "sorteio" ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <AdminStatCard compact label="Comentários" value={session.entries.length} hint="Comentários importados" icon={FileSpreadsheet} />
            <AdminStatCard compact label="Participantes únicos" value={uniqueParticipants} hint="Perfis diferentes" icon={Users} />
            <AdminStatCard compact label="Total de chances" value={session.entries.length} hint="Cada comentário = 1 chance" icon={Sparkles} tone="success" />
            <AdminStatCard
              compact
              label="Regra"
              value="1 comentário = 1 chance"
              hint="Quanto mais comentar, mais chances de ganhar."
              icon={ShieldQuestion}
              tone="info"
            />
          </div>

          <AdminSection compact title="Importar comentários" description="CSV exportado do Instagram: entry_number, comment_id, username, comment, mentions_count, mentions, comment_url, chance.">
            <InstagramImport locked={isCsvLocked} initialStatus={initialInstagramStatus} onImported={handleInstagramImported} />
            <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wider text-slate-500"><span className="h-px flex-1 bg-slate-800" />ou CSV<span className="h-px flex-1 bg-slate-800" /></div>
            {isCsvLocked ? (
              <AdminEmptyState
                title="Sorteio em andamento"
                description="Para importar um novo arquivo é preciso resetar o sorteio atual formalmente."
              />
            ) : (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`rounded-2xl border-2 border-dashed p-6 text-center transition ${
                  dragOver ? "border-emerald-400 bg-emerald-500/10" : "border-slate-700 bg-slate-950/50"
                }`}
              >
                <Upload className="mx-auto text-emerald-300" size={28} />
                <p className="mt-2 text-sm text-slate-300">Arraste o arquivo CSV aqui ou</p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-3 inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300"
                >
                  <Upload size={16} /> IMPORTAR COMENTÁRIOS
                </button>
                <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFileInput} />
              </div>
            )}

            {importError ? (
              <p className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{importError}</p>
            ) : null}
            {persistenceError ? <p className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">Supabase: {persistenceError}</p> : null}

            {importSummary ? (
              <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                <p className="font-semibold">Arquivo importado com sucesso.</p>
                <p>{importSummary.imported} comentários carregados.</p>
                {importSummary.duplicateCommentIdsSkipped || importSummary.invalidRowsSkipped || importSummary.emptyRowsSkipped ? (
                  <p className="mt-1 text-xs text-emerald-200/80">
                    {importSummary.duplicateCommentIdsSkipped ? `${importSummary.duplicateCommentIdsSkipped} duplicados ignorados. ` : ""}
                    {importSummary.invalidRowsSkipped ? `${importSummary.invalidRowsSkipped} linhas inválidas ignoradas. ` : ""}
                    {importSummary.emptyRowsSkipped ? `${importSummary.emptyRowsSkipped} linhas vazias ignoradas.` : ""}
                  </p>
                ) : null}
              </div>
            ) : null}
          </AdminSection>

          {session.entries.length === 0 ? null : (
            <AdminSection compact title="Sorteio">
              {session.status === "ready" ? (
                noEligibleParticipants ? (
                  <AdminEmptyState title="Não há mais participantes elegíveis" description="Todos os comentários foram desclassificados neste sorteio." />
                ) : (
                  <div className="rounded-2xl border border-emerald-500/20 bg-slate-950/50 p-6 text-center">
                    <Trophy className="mx-auto text-emerald-300" size={32} />
                    <h3 className="mt-2 text-lg font-semibold text-white">PRONTO PARA SORTEAR</h3>
                    <p className="mt-1 text-sm text-slate-300">{activePool.length} chances carregadas.</p>
                    <button
                      type="button"
                      disabled={criticalPending}
                      onClick={handleDrawClick}
                      className="mx-auto mt-4 inline-flex items-center gap-2 rounded-2xl bg-emerald-400 px-6 py-3 text-base font-semibold text-slate-950 shadow-lg shadow-emerald-950/30 hover:bg-emerald-300"
                    >
                      <Sparkles size={20} /> REALIZAR SORTEIO
                    </button>
                  </div>
                )
              ) : null}

              {session.status === "drawing" ? (
                <RouletteAnimation key={drawAttempt} pool={drawPool} winner={winnerEntry ?? drawPool[0]} onComplete={handleAnimationComplete} />
              ) : null}

              {session.status === "awaiting_validation" && winnerEntry ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">E o(a) ganhador(a) é...</p>
                    <p className="mt-2 text-3xl font-bold text-white">@{winnerEntry.username}</p>
                    <p className="mt-3 text-sm text-slate-300">Comentário vencedor:</p>
                    <p className="mt-1 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-100">“{winnerEntry.comment}”</p>
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-300">
                      <div><dt className="text-slate-500">Entrada</dt><dd>#{winnerEntry.entryNumber}</dd></div>
                      <div><dt className="text-slate-500">ID do comentário</dt><dd className="font-mono">{winnerEntry.commentId}</dd></div>
                      <div><dt className="text-slate-500">Data/hora do sorteio</dt><dd>{formatDateTime(session.currentDrawAt)}</dd></div>
                      <div><dt className="text-slate-500">Total de chances</dt><dd>{session.entries.length}</dd></div>
                    </dl>
                    {winnerEntry.commentUrl ? (
                      <a
                        href={winnerEntry.commentUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-300 hover:text-emerald-200"
                      >
                        VER COMENTÁRIO NO INSTAGRAM <ExternalLink size={14} />
                      </a>
                    ) : null}
                  </div>

                  <div className="rounded-2xl border border-slate-800 bg-slate-950/50 p-5">
                    <p className="text-sm font-semibold text-white">Validação do ganhador</p>
                    <p className="mt-1 text-xs text-slate-400">
                      O cumprimento das regras deve ser conferido manualmente antes da confirmação do ganhador.
                    </p>
                    <div className="mt-3 space-y-2">
                      {([
                        ["follows", `Segue ${INSTAGRAM_HANDLE}`],
                        ["liked", "Curtiu a publicação oficial"],
                        ["taggedFriends", "Marcou os amigos conforme regulamento"],
                        ["sharedStory", `Compartilhou nos Stories marcando ${INSTAGRAM_HANDLE}`],
                      ] as const).map(([key, label]) => (
                        <label key={key} className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-200">
                          <input
                            type="checkbox"
                            checked={session.currentChecklist[key]}
                            onChange={() => handleChecklistToggle(key)}
                            className="h-4 w-4 accent-emerald-400"
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    {winnerEntry.mentionsCount === null ? (
                      <p className="mt-3 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200">
                        <AlertTriangle size={14} /> Verificação manual necessária: marcações não puderam ser determinadas automaticamente.
                      </p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={!checklistComplete || criticalPending}
                        onClick={() => setShowConfirmWinner(true)}
                        className="flex-1 rounded-xl bg-emerald-400 px-3 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        CONFIRMAR GANHADOR
                      </button>
                      <button
                        type="button"
                        disabled={criticalPending}
                        onClick={() => setShowDisqualify(true)}
                        className="flex-1 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2.5 text-sm font-semibold text-rose-200 hover:bg-rose-500/20"
                      >
                        DESCLASSIFICAR E SORTEAR NOVAMENTE
                      </button>
                    </div>
                    {!checklistComplete ? (
                      <p className="mt-2 text-center text-xs text-slate-500">Marque todos os itens para liberar a confirmação.</p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {session.status === "finalized" && confirmedWinnerEntry ? (
                <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-6">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Ganhador confirmado</p>
                  <p className="mt-2 text-3xl font-bold text-white">@{confirmedWinnerEntry.username}</p>
                  <p className="mt-2 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm text-slate-100">“{confirmedWinnerEntry.comment}”</p>
                  <p className="mt-2 text-xs text-slate-400">{formatDateTime(session.confirmedWinner?.confirmedAt ?? null)}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => downloadComprovantePdf(session)}
                      className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-2.5 text-sm font-medium text-slate-100 hover:border-emerald-400/60"
                    >
                      <Download size={16} /> BAIXAR RESULTADO
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadShareImage(confirmedWinnerEntry.username, session.id)}
                      className="inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-emerald-300"
                    >
                      <Share2 size={16} /> COMPARTILHAR RESULTADO
                    </button>
                  </div>
                </div>
              ) : null}
            </AdminSection>
          )}

          <AdminSection compact title="Histórico do sorteio" description="Registro permanente de todos os acontecimentos deste sorteio.">
            {timelineItems.length > 0 ? (
              <AdminActivityTimeline items={timelineItems} />
            ) : (
              <p className="flex items-center gap-2 text-sm text-slate-400">
                <HistoryIcon size={16} /> Nenhum evento registrado ainda.
              </p>
            )}
          </AdminSection>
        </div>
      ) : null}

      {tab === "participacoes" ? (
        <AdminSection compact title="Participações">
          {session.entries.length === 0 ? (
            <AdminEmptyState title="Nenhum comentário importado" description="Importe o CSV na aba Sorteio para ver as participações." />
          ) : (
            <ParticipationsTable session={session} />
          )}
        </AdminSection>
      ) : null}

      {tab === "transparencia" ? (
        <AdminSection compact title="Transparência do sorteio">
          <TransparencyPanel session={session} archived={archived} />
        </AdminSection>
      ) : null}

      <RulesDialog open={showRules} onClose={() => setShowRules(false)} />

      <DisqualifyModal
        open={showDisqualify}
        winner={winnerEntry}
        onClose={() => setShowDisqualify(false)}
        onConfirm={handleDisqualifyConfirm}
        pending={criticalPending}
      />

      <StrongConfirmModal
        open={showConfirmWinner}
        title="Confirmar ganhador"
        description="Você verificou manualmente todas as regras da promoção?"
        confirmLabel="SIM, CONFIRMAR GANHADOR"
        onCancel={() => setShowConfirmWinner(false)}
        onConfirm={handleConfirmWinnerFinal}
        pending={criticalPending}
      />

      <StrongConfirmModal
        open={showResetConfirm}
        title="Resetar sorteio"
        description="Esta ação iniciará um novo sorteio e encerrará a sessão atual. O histórico do sorteio atual será preservado na Transparência, mas será necessário importar o CSV novamente."
        confirmLabel="RESETAR SORTEIO"
        tone="rose"
        onCancel={() => setShowResetConfirm(false)}
        onConfirm={handleResetConfirmed}
      />
    </div>
  );
}
