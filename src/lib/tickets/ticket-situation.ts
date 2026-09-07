/**
 * Classificacao operacional de ingresso para listagens (Minha Conta e Admin).
 *
 * Status reais em `tickets.status` (check tickets_status_check):
 *   active | used | cancelled
 *
 * Nao existe status de ingresso "inativo"/"invalidado". A menor normalizacao
 * visivel, sem criar coluna nova:
 *   - Cancelado  = tickets.status = cancelled
 *   - Anterior   = ingresso nao cancelado cujo evento ja encerrou
 *   - Inativo    = ingresso nao cancelado, evento ainda nao encerrou, mas
 *                  events.is_active = false (evento desativado/arquivado)
 *   - Ativo      = ingresso nao cancelado + evento futuro/em andamento + evento ativo
 *
 * Data canonica de encerramento: events.ends_at. Se estiver nula, usa
 * events.starts_at -- unico timestamp de calendario disponivel. Sem as duas
 * datas, o evento nao e classificado como passado.
 *
 * A funcao SQL `ticket_operational_situation` deve permanecer identica.
 */

export const TICKET_DB_STATUSES = ['active', 'used', 'cancelled'] as const;
export type TicketDbStatus = (typeof TICKET_DB_STATUSES)[number];

export const TICKET_SITUATIONS = ['ativos', 'anteriores', 'cancelados', 'inativos'] as const;
export type TicketOperationalSituation = (typeof TICKET_SITUATIONS)[number];
export type TicketSituationFilter = TicketOperationalSituation | 'todos';

export const TICKET_SITUATION_LABELS: Record<TicketOperationalSituation, string> = {
  ativos: 'Ativo',
  anteriores: 'Evento encerrado',
  cancelados: 'Cancelado',
  inativos: 'Inativo',
};

export function isTicketDbStatus(value: string | null | undefined): value is TicketDbStatus {
  const normalized = String(value ?? '').trim().toLowerCase();
  return (TICKET_DB_STATUSES as readonly string[]).includes(normalized);
}

export function eventHasEnded(
  input: { endsAt?: string | null; startsAt?: string | null },
  nowMs = Date.now(),
) {
  const canonicalEnd = input.endsAt || input.startsAt || null;
  if (!canonicalEnd) return false;
  const ts = new Date(canonicalEnd).getTime();
  if (!Number.isFinite(ts)) return false;
  return ts <= nowMs;
}

export function classifyTicketOperationalSituation(
  input: {
    ticketStatus: string | null | undefined;
    eventEndsAt?: string | null;
    eventStartsAt?: string | null;
    eventIsActive?: boolean | null;
  },
  nowMs = Date.now(),
): TicketOperationalSituation {
  const status = String(input.ticketStatus ?? '').trim().toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return 'cancelados';
  if (eventHasEnded({ endsAt: input.eventEndsAt, startsAt: input.eventStartsAt }, nowMs)) return 'anteriores';
  if (input.eventIsActive === false) return 'inativos';
  return 'ativos';
}

export function ticketSituationLabel(situation: TicketOperationalSituation) {
  return TICKET_SITUATION_LABELS[situation];
}

export function ticketSituationBadgeStatus(situation: TicketOperationalSituation) {
  if (situation === 'ativos') return 'active';
  if (situation === 'anteriores') return 'event_ended';
  if (situation === 'cancelados') return 'cancelled';
  return 'inactive';
}

export function parseTicketSituationFilter(value: string | null | undefined): TicketSituationFilter {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'todos') return 'todos';
  if ((TICKET_SITUATIONS as readonly string[]).includes(normalized)) {
    return normalized as TicketOperationalSituation;
  }
  return 'ativos';
}

export function partitionTicketsBySituation<T>(
  tickets: T[],
  situationOf: (ticket: T) => TicketOperationalSituation,
) {
  const active: T[] = [];
  const archived: T[] = [];
  for (const ticket of tickets) {
    if (situationOf(ticket) === 'ativos') active.push(ticket);
    else archived.push(ticket);
  }
  return { active, archived };
}
