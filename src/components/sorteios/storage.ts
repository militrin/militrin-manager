import { EMPTY_CHECKLIST, type ArchivedSession, type SorteioSession } from "./types";

const SESSION_KEY = "militrin-sorteio-session-v1";
const ARCHIVE_KEY = "militrin-sorteio-archive-v1";
const SEQUENCE_KEY = "militrin-sorteio-sequence-v1";

function nextSequence(): number {
  if (typeof window === "undefined") return 1;
  const raw = window.localStorage.getItem(SEQUENCE_KEY);
  const current = raw ? Number.parseInt(raw, 10) || 0 : 0;
  const next = current + 1;
  window.localStorage.setItem(SEQUENCE_KEY, String(next));
  return next;
}

export function generateSorteioId(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const seq = String(nextSequence()).padStart(3, "0");
  return `MILITRIN-${year}-${month}${day}-${seq}`;
}

export function createEmptySession(): SorteioSession {
  return {
    databaseId: null,
    id: generateSorteioId(),
    createdAt: new Date().toISOString(),
    importedFileName: null,
    importedAt: null,
    entries: [],
    status: "empty",
    currentWinnerCommentId: null,
    currentDrawAt: null,
    currentChecklist: { ...EMPTY_CHECKLIST },
    disqualifications: [],
    confirmedWinner: null,
    history: [],
    source: "csv",
    instagramMediaId: null,
    instagramMediaPermalink: null,
    instagramIntegrationId: null,
    snapshotFrozenAt: null,
  };
}

export function loadSession(): SorteioSession {
  if (typeof window === "undefined") return createEmptySession();
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return createEmptySession();
    const parsed = JSON.parse(raw) as SorteioSession;
    if (!parsed || typeof parsed !== "object" || !parsed.id) return createEmptySession();
    return {
      ...parsed,
      databaseId: parsed.databaseId ?? null,
      entries: Array.isArray(parsed.entries) ? parsed.entries.map((entry) => ({ ...entry, commentCreatedAt: entry.commentCreatedAt ?? null })) : [],
      source: parsed.source ?? "csv",
      instagramMediaId: parsed.instagramMediaId ?? null,
      instagramMediaPermalink: parsed.instagramMediaPermalink ?? null,
      instagramIntegrationId: parsed.instagramIntegrationId ?? null,
      snapshotFrozenAt: parsed.snapshotFrozenAt ?? null,
    };
  } catch {
    return createEmptySession();
  }
}

export function saveSession(session: SorteioSession) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function archiveSession(session: SorteioSession) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(ARCHIVE_KEY);
    const archive: ArchivedSession[] = raw ? JSON.parse(raw) : [];
    archive.push({ ...session, archivedAt: new Date().toISOString() });
    window.localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive));
  } catch {
    // histórico é best-effort no localStorage; nunca deve travar o reset.
  }
}

export function loadArchivedSessions(): ArchivedSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function makeHistoryEventId() {
  return crypto.randomUUID();
}
