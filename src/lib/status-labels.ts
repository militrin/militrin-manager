const STATUS_LABELS: Record<string, string> = {
  active: 'Ativo',
  assigned: 'Atribuído',
  cancelled: 'Cancelado',
  canceled: 'Cancelado',
  confirmed: 'Confirmado',
  delivered: 'Entregue',
  expired: 'Expirado',
  failed: 'Falhou',
  paid: 'Pago',
  pending: 'Pendente',
  processing: 'Processando',
  refunded: 'Reembolsado',
  reserved: 'Reservado',
  transferred: 'Transferido',
  unassigned: 'Sem titular',
  used: 'Utilizado',
};

export const TIMELINE_STATE_LABELS = {
  active: 'Ativo',
  approved: 'Aprovado',
  assigned: 'Atribuído',
  cancelled: 'Cancelado',
  canceled: 'Cancelado',
  claimed: 'Reivindicado',
  completed: 'Concluído',
  confirmed: 'Confirmado',
  delivered: 'Entregue',
  duplicate: 'Duplicado',
  expired: 'Expirado',
  failed: 'Falhou',
  inactive: 'Inativo',
  issued: 'Emitido',
  missing: 'Não existente',
  not_issued: 'Não emitido',
  open: 'Aberto',
  paid: 'Confirmado',
  pending: 'Pendente',
  processing: 'Em processamento',
  refunded: 'Reembolsado',
  rejected: 'Rejeitado',
  reserved: 'Reservado',
  resolved: 'Resolvido',
  revoked: 'Revogado',
  transferred: 'Transferido',
  unassigned: 'Sem titular',
  used: 'Utilizado',
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getTimelineStateLabel(
  state: string | null | undefined,
  context: { eventType?: string; field?: string; log?: (message: string) => void } = {},
) {
  const normalized = String(state ?? '').trim().toLowerCase();
  if (!normalized) return null;
  const known = TIMELINE_STATE_LABELS[normalized as keyof typeof TIMELINE_STATE_LABELS];
  if (known) return known;
  const safeLabel = UUID_PATTERN.test(normalized) ? 'Referência registrada' : 'Estado não reconhecido';
  const payload = JSON.stringify({ source: 'ticket-timeline-state', eventType: context.eventType, field: context.field, valueKind: UUID_PATTERN.test(normalized) ? 'uuid' : 'unknown' });
  (context.log ?? console.warn)(`[ticket-timeline:unknown-state] ${payload}`);
  return safeLabel;
}

export function isCanonicalTimelineState(state: string | null | undefined) {
  const normalized = String(state ?? '').trim().toLowerCase();
  return normalized in TIMELINE_STATE_LABELS;
}

export function getStatusLabel(status: string | null | undefined, fallback = '-') {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  return STATUS_LABELS[normalized] ?? String(status);
}
