export const ACCOUNT_HEALTH_PERMISSION = 'accounts.health.view';

export const ACCOUNT_HEALTH_STATES = [
  'healthy',
  'pending_confirmation',
  'no_account',
  'confirmed_unlinked',
  'email_divergent',
  'auth_without_contact',
  'possible_orphan',
  'attention',
] as const;

export type AccountHealthState = (typeof ACCOUNT_HEALTH_STATES)[number];

export const ACCOUNT_HEALTH_FILTERS = [
  'all',
  'healthy',
  'pending_confirmation',
  'no_account',
  'attention',
  'auth_without_contact',
  'email_divergent',
  'possible_orphan',
] as const;

export type AccountHealthFilter = (typeof ACCOUNT_HEALTH_FILTERS)[number];

export type AccountHealthAction =
  | 'resend_confirmation'
  | 'send_invite'
  | 'send_access'
  | 'open_contact';

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
};

export type AccountHealthCounts = {
  total: number;
  healthy: number;
  pending_confirmation: number;
  no_account: number;
  confirmed_unlinked: number;
  email_divergent: number;
  attention: number;
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
  tickets: Array<{
    ticket_id: string;
    display_number: string | null;
    status: string | null;
    is_owner: boolean;
  }>;
  diagnosis: string;
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
};

export const ACCOUNT_HEALTH_FILTER_LABEL: Record<AccountHealthFilter, string> = {
  all: 'Todos',
  healthy: 'Saudáveis',
  pending_confirmation: 'Aguardando confirmação',
  no_account: 'Sem conta',
  attention: 'Requer atenção',
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
