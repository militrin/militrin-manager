import { isValidCpf } from '../imports/import-row-validation.ts';

export type SharedEmailPersonCandidate = {
  id: string;
  fullName: string;
  cpf?: string | null;
  birthDate?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  userId?: string | null;
  hasValidAuth?: boolean;
  sourceRow?: number | null;
  createdAt?: string | null;
};

export function sharedEmailCadastroScore(person: SharedEmailPersonCandidate, groupEmail: string) {
  let score = 0;
  if (String(person.fullName ?? '').trim().length >= 3) score += 1;
  if (isValidCpf(person.cpf)) score += 2;
  if (String(person.birthDate ?? '').trim()) score += 2;
  if (String(person.email ?? '').trim().toLowerCase() === String(groupEmail ?? '').trim().toLowerCase()) score += 1;
  if (String(person.phone ?? '').replace(/\D/g, '').length >= 10) score += 1;
  if (String(person.city ?? '').trim()) score += 1;
  return score;
}

export function chooseSharedEmailPrincipal(
  people: SharedEmailPersonCandidate[],
  groupEmail: string,
): SharedEmailPersonCandidate | null {
  if (!people.length) return null;
  return [...people].sort((left, right) => {
    const leftAuth = Boolean(left.hasValidAuth && left.userId);
    const rightAuth = Boolean(right.hasValidAuth && right.userId);
    if (leftAuth !== rightAuth) return leftAuth ? -1 : 1;
    const scoreDiff = sharedEmailCadastroScore(right, groupEmail) - sharedEmailCadastroScore(left, groupEmail);
    if (scoreDiff !== 0) return scoreDiff;
    const leftRow = left.sourceRow ?? Number.MAX_SAFE_INTEGER;
    const rightRow = right.sourceRow ?? Number.MAX_SAFE_INTEGER;
    if (leftRow !== rightRow) return leftRow - rightRow;
    return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
      || String(left.id).localeCompare(String(right.id));
  })[0] ?? null;
}

export function maskSharedEmail(email: string | null | undefined) {
  const value = String(email ?? '').trim().toLowerCase();
  const at = value.indexOf('@');
  if (at < 1) return value || null;
  return `${value.slice(0, 2)}***@${value.slice(at + 1)}`;
}

export function normalizeSharedEmail(email: string | null | undefined) {
  const value = String(email ?? '').trim().toLowerCase();
  return value || null;
}

export type SharedEmailFilter = 'all' | 'pending' | 'resolved';
export type SharedEmailGroupStatus = 'pending' | 'resolved';

export function parseSharedEmailFilter(value: string | null | undefined): SharedEmailFilter {
  if (value === 'pending' || value === 'resolved' || value === 'all') return value;
  return 'all';
}

export function countSharedEmails(emails: Array<string | null | undefined>) {
  const counts = new Map<string, number>();
  for (const email of emails) {
    const key = normalizeSharedEmail(email);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function sharedEmailBadgeLabel(count: number) {
  return `${count} cadastros neste e-mail`;
}

export function sharedEmailResolvedAccountLabel(name: string | null | undefined) {
  const value = String(name ?? '').trim();
  return value ? `Conta: ${value} ✓` : null;
}

export function sharedEmailCompactMeta(count: number) {
  return `${count} cadastros · Compartilhado`;
}

export function sharedEmailPrincipalCompactLabel(name: string | null | undefined) {
  const value = String(name ?? '').trim();
  return value ? `${value} ✓` : null;
}

export function sharedEmailCountersLabel(pending: number, resolved: number) {
  return `Pendentes: ${pending} · Resolvidos: ${resolved}`;
}

export function sharedEmailGroupCount(emails: Array<string | null | undefined>) {
  return [...countSharedEmails(emails).values()].filter((count) => count > 1).length;
}

export function sharedEmailGroupStatus(
  tickets: Array<{ intendedOwnerContactId?: string | null }>,
): { status: SharedEmailGroupStatus; principalId: string | null } {
  if (!tickets.length) return { status: 'pending', principalId: null };
  const current = currentSharedEmailPrincipalId(tickets);
  const allHaveIntended = tickets.every((ticket) => String(ticket.intendedOwnerContactId ?? '').trim());
  if (current.id && current.unanimous && allHaveIntended) {
    return { status: 'resolved', principalId: current.id };
  }
  return { status: 'pending', principalId: current.id };
}

export function matchesSharedEmailFilter(
  sharedCount: number,
  groupStatus: SharedEmailGroupStatus | null,
  filter: SharedEmailFilter,
) {
  if (filter === 'all') return true;
  if (sharedCount <= 1 || !groupStatus) return false;
  return groupStatus === filter;
}

export function currentSharedEmailPrincipalId(
  tickets: Array<{ intendedOwnerContactId?: string | null }>,
) {
  const counts = new Map<string, number>();
  for (const ticket of tickets) {
    const id = String(ticket.intendedOwnerContactId ?? '').trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (counts.size === 0) return { id: null as string | null, unanimous: true, mixed: false };
  let selected: string | null = null;
  let selectedCount = 0;
  for (const [id, count] of counts) {
    if (count > selectedCount || (count === selectedCount && selected && id < selected)) {
      selected = id;
      selectedCount = count;
    }
  }
  return { id: selected, unanimous: counts.size === 1, mixed: counts.size > 1 };
}

export const TICKET_ACCOUNT_OWNER_REASON_OPTIONS = [
  { code: 'shared_email', label: 'E-mail compartilhado' },
  { code: 'family_responsible', label: 'Responsável familiar' },
  { code: 'account_correction', label: 'Correção de conta' },
  { code: 'administrative_transfer', label: 'Transferência administrativa' },
  { code: 'other', label: 'Outro' },
] as const;

export type TicketAccountOwnerReasonCode = typeof TICKET_ACCOUNT_OWNER_REASON_OPTIONS[number]['code'];

export function isTicketAccountOwnerReasonCode(value: string): value is TicketAccountOwnerReasonCode {
  return TICKET_ACCOUNT_OWNER_REASON_OPTIONS.some((item) => item.code === value);
}

export function ticketAccountOwnerReasonLabel(code: string | null | undefined) {
  return TICKET_ACCOUNT_OWNER_REASON_OPTIONS.find((item) => item.code === code)?.label ?? null;
}

export function validateTicketAccountOwnerReason(code: string, text?: string | null) {
  if (!isTicketAccountOwnerReasonCode(code)) throw new Error('Selecione um motivo válido.');
  const reasonText = text?.trim() || null;
  if (code === 'other' && !reasonText) throw new Error('Descreva o motivo da alteração.');
  return { reasonCode: code, reasonText };
}
