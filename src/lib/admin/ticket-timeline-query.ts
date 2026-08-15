export type TimelineQueryError = { code?: string; message?: string };

type TimelineQueryResult<T> = { data: T | null; error: TimelineQueryError | null };

export async function loadOptionalTimelineSource<T>(
  source: string,
  query: PromiseLike<TimelineQueryResult<T>>,
  ticketId: string,
  warnings: string[],
  log: (message: string, context: Record<string, unknown>) => void = (message, context) => console.error(message, JSON.stringify(context)),
): Promise<T | null> {
  try {
    const result = await query;
    if (!result.error) return result.data;
    log(`[ticket-timeline:${source}]`, { ticketId, code: result.error.code, message: result.error.message });
  } catch (error) {
    log(`[ticket-timeline:${source}]`, { ticketId, message: error instanceof Error ? error.message : "Falha desconhecida" });
  }
  warnings.push(source);
  return null;
}

type DeduplicableTimelineEvent = { id: string; occurredAt: string; type: string; source: "functional" | "audit" };

export function deduplicateTicketTimelineEvents<T extends DeduplicableTimelineEvent>(events: T[]) {
  const seen = new Set<string>();
  return [...events]
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))
    .filter((event) => {
      const key = event.type === "ticket_issued" ? "ticket_issued"
        : event.source === "audit" ? event.id
        : `${event.type}|${event.occurredAt.slice(0, 19)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
