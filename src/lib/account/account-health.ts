export const ACCOUNT_HEALTH_PERMISSION = 'accounts.health.view';
export const ACCOUNT_HEALTH_RESOLVE_PERMISSION = 'accounts.health.resolve';

/**
 * Cadastro.email is the canonical cadastral address.
 * participant.email is an operational snapshot of the participation.
 * V2 aligns participant.email only when it still equals the previous Cadastro email.
 * participant.user_id, tickets, orders and ownership stay untouched.
 * keep_without_account is a decision about account access, not Pessoa existence.
 * Overlay reviewed_without_account only applies while the resolution fingerprint still matches.
 */
export const ACCOUNT_HEALTH_STATES = [
  'healthy',
  'pending_confirmation',
  'no_account',
  'confirmed_unlinked',
  'email_divergent',
  'auth_without_contact',
  'possible_orphan',
  'attention',
  'reviewed_without_account',
] as const;

export type AccountHealthState = (typeof ACCOUNT_HEALTH_STATES)[number];

export const ACCOUNT_HEALTH_FILTERS = [
  'all',
  'healthy',
  'pending_confirmation',
  'no_account',
  'attention',
  'reviewed_without_account',
  'auth_without_contact',
  'email_divergent',
  'possible_orphan',
] as const;

export type AccountHealthFilter = (typeof ACCOUNT_HEALTH_FILTERS)[number];

export type AccountHealthAction =
  | 'resend_confirmation'
  | 'send_invite'
  | 'send_access'
  | 'open_contact'
  | 'keep_without_account'
  | 'provide_own_email'
  | 'reopen_review'
  | 'review_identity';

export type AccountHealthResolution = {
  code: string;
  reason_code: string | null;
  status: string;
  resolved_at: string | null;
  resolved_by_name: string | null;
  notes: string | null;
};

export type AccountHealthIdentityConflict = {
  cadastro_email: string | null;
  linked_email: string | null;
  linked_confirmed: boolean | null;
  linked_last_sign_in_at: string | null;
  occupying_email: string | null;
  occupying_confirmed: boolean | null;
  occupying_last_sign_in_at: string | null;
  occupying_has_cadastro: boolean | null;
  message: string | null;
};

export type AccountHealthListRow = {
  case_id: string;
  organization_id: string;
  registration_contact_id: string | null;
  participant_id: string | null;
  state: AccountHealthState;
  reason_code: string;
  reason_message: string;
  display_name: string | null;
  display_email: string | null;
  auth_confirmed: boolean | null;
  has_registration: boolean;
  has_participant: boolean;
  has_orders: boolean;
  has_tickets: boolean;
  is_owner: boolean;
  last_activity_at: string | null;
  available_actions: AccountHealthAction[];
  participant_email_divergent: boolean;
  shared_email: boolean;
  resolution?: AccountHealthResolution | null;
};

export type AccountHealthCounts = {
  total: number;
  healthy: number;
  pending_confirmation: number;
  no_account: number;
  confirmed_unlinked: number;
  email_divergent: number;
  attention: number;
  reviewed_without_account: number;
  auth_without_contact: number;
  auth_without_contact_confirmed: number;
  possible_orphan: number;
  possible_orphan_confirmed: number;
  possible_orphan_unconfirmed: number;
};

export type AccountHealthListPayload = {
  counts: AccountHealthCounts;
  rows: AccountHealthListRow[];
  page: number;
  page_size: number;
  row_count: number;
  can_view_orphans: boolean;
};

export type AccountHealthTicket = {
  ticket_id: string;
  display_number: string | null;
  status: string | null;
  is_owner: boolean;
  is_titular?: boolean;
  owner_defined?: boolean;
  ownership_label?: string | null;
};

export type AccountHealthCaseDetail = {
  found: boolean;
  case: AccountHealthListRow | null;
  identity: {
    full_name: string | null;
    cpf: string | null;
    email: string | null;
  } | null;
  account: {
    confirmed: boolean | null;
    created_at: string | null;
    last_sign_in_at: string | null;
  } | null;
  participation: Array<{
    participant_id: string;
    event_name: string | null;
    email: string | null;
  }>;
  tickets: AccountHealthTicket[];
  diagnosis: string;
  resolution?: AccountHealthResolution | null;
  identity_conflict?: AccountHealthIdentityConflict | null;
  last_email_correction?: {
    old_email: string | null;
    new_email: string | null;
    resolved_at: string | null;
  } | null;
};

export const ACCOUNT_HEALTH_STATE_LABEL: Record<AccountHealthState, string> = {
  healthy: 'Saudável',
  pending_confirmation: 'Aguardando confirmação',
  no_account: 'Sem conta',
  confirmed_unlinked: 'Conta existente',
  email_divergent: 'E-mail divergente',
  auth_without_contact: 'Conta sem cadastro',
  possible_orphan: 'Possível órfã',
  attention: 'Requer atenção',
  reviewed_without_account: 'Revisado — sem conta',
};

export const ACCOUNT_HEALTH_STATE_TONE: Record<AccountHealthState, 'success' | 'warning' | 'danger' | 'info' | 'default'> = {
  healthy: 'success',
  pending_confirmation: 'warning',
  no_account: 'default',
  confirmed_unlinked: 'info',
  email_divergent: 'warning',
  auth_without_contact: 'info',
  possible_orphan: 'warning',
  attention: 'danger',
  reviewed_without_account: 'success',
};

export const ACCOUNT_HEALTH_FILTER_LABEL: Record<AccountHealthFilter, string> = {
  all: 'Todos',
  healthy: 'Saudáveis',
  pending_confirmation: 'Aguardando confirmação',
  no_account: 'Sem conta',
  attention: 'Requer atenção',
  reviewed_without_account: 'Revisados',
  auth_without_contact: 'Conta sem cadastro',
  email_divergent: 'E-mail divergente',
  possible_orphan: 'Possível órfã',
};

export function isAccountHealthFilter(value: string | null | undefined): value is AccountHealthFilter {
  return ACCOUNT_HEALTH_FILTERS.includes(String(value ?? '') as AccountHealthFilter);
}

export function parseAccountHealthFilter(
  value: string | null | undefined,
  canViewOrphans = true,
): AccountHealthFilter {
  const parsed = isAccountHealthFilter(value) ? value : 'all';
  if (parsed === 'possible_orphan' && !canViewOrphans) return 'all';
  return parsed;
}

export function accountHealthFiltersForActor(canViewOrphans: boolean): AccountHealthFilter[] {
  return ACCOUNT_HEALTH_FILTERS.filter((filter) => filter !== 'possible_orphan' || canViewOrphans);
}

export function accountHealthActionError(
  row: Pick<AccountHealthListRow, 'available_actions'> | null | undefined,
  action: AccountHealthAction,
) {
  if (!row?.available_actions?.includes(action)) {
    return 'Esta ação não está disponível para o estado atual.';
  }
  return null;
}

export function accountHealthHref(input: {
  state?: string | null;
  q?: string | null;
  page?: string | number | null;
  pageSize?: string | number | null;
}) {
  const params = new URLSearchParams();
  if (input.state && input.state !== 'all') params.set('estado', input.state);
  if (input.q) params.set('q', input.q);
  if (input.page && Number(input.page) > 1) params.set('page', String(input.page));
  if (input.pageSize && Number(input.pageSize) !== 25) params.set('pageSize', String(input.pageSize));
  const query = params.toString();
  return query ? `/cadastros/saude-contas?${query}` : '/cadastros/saude-contas';
}

export function accountHealthCaseHref(caseId: string) {
  return `/cadastros/saude-contas/${encodeURIComponent(caseId)}`;
}

export function accountHealthNoAccountCount(counts: AccountHealthCounts) {
  return counts.no_account + counts.confirmed_unlinked;
}

export function accountHealthConfirmedWithoutContactCount(counts: AccountHealthCounts) {
  return counts.confirmed_unlinked + counts.auth_without_contact_confirmed;
}

export function accountHealthTicketCopy(ticket: Pick<AccountHealthTicket, 'is_owner' | 'is_titular' | 'owner_defined' | 'ownership_label'>) {
  if (ticket.ownership_label) return ticket.ownership_label;
  if (ticket.is_owner) return 'Esta pessoa é dona da conta deste ingresso.';
  if (ticket.owner_defined === false) return 'A conta deste ingresso ainda não foi definida.';
  if (ticket.is_titular) return 'Esta pessoa é titular. A conta que acessa este ingresso é de outra pessoa.';
  return 'A conta deste ingresso pertence a outra pessoa.';
}

export function accountHealthProblemTitle(row: Pick<AccountHealthListRow, 'state' | 'reason_code'>) {
  if (row.state === 'reviewed_without_account') return 'Revisado';
  if (row.reason_code === 'occupying_email_auth') return 'Conflito de conta';
  if (row.reason_code === 'shared_email' && row.state === 'attention') return 'Problema encontrado';
  if (row.state === 'attention') return 'Problema encontrado';
  return ACCOUNT_HEALTH_STATE_LABEL[row.state] ?? 'Situação';
}

export function accountHealthProblemSummary(row: Pick<AccountHealthListRow, 'state' | 'reason_code' | 'reason_message'>) {
  if (row.state === 'reviewed_without_account') {
    return 'Este Cadastro foi revisado e permanecerá sem conta própria.';
  }
  if (row.reason_code === 'occupying_email_auth') {
    return 'Este Cadastro já está vinculado a uma conta ativa, mas o e-mail cadastrado está sendo usado por outra conta. A correção exige revisar qual conta deve permanecer.';
  }
  if (row.reason_code === 'shared_email') {
    return 'Este e-mail é compartilhado com outra pessoa que já possui uma conta.';
  }
  return row.reason_message;
}

export function accountHealthAccountSituation(row: Pick<AccountHealthListRow, 'state' | 'auth_confirmed' | 'has_registration'>) {
  if (row.state === 'reviewed_without_account' || row.state === 'no_account') return 'Sem conta própria';
  if (row.state === 'pending_confirmation') return 'Conta aguardando confirmação';
  if (row.state === 'confirmed_unlinked') return 'Existe uma conta com este e-mail, ainda sem vínculo';
  if (row.auth_confirmed === true) return 'Conta confirmada';
  if (row.auth_confirmed === false) return 'Conta pendente';
  return 'Sem conta própria';
}

export function isSharedEmailHealthCase(row: Pick<AccountHealthListRow, 'state' | 'reason_code'> | null | undefined) {
  return row?.state === 'attention' && row.reason_code === 'shared_email';
}

export function isOccupyingEmailHealthCase(row: Pick<AccountHealthListRow, 'reason_code'> | null | undefined) {
  return row?.reason_code === 'occupying_email_auth';
}
