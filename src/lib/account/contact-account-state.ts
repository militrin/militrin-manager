export type ContactAccountState =
  | 'active'
  | 'pending_confirmation'
  | 'existing_confirmed'
  | 'none'
  | 'attention';

export type ContactAccountStateView = {
  state: ContactAccountState;
  label: string;
  marker: string;
  canResendConfirmation: boolean;
  canInvite: boolean;
  inviteCreatesAuth: boolean;
};

const VIEWS: Record<ContactAccountState, Omit<ContactAccountStateView, 'state'>> = {
  active: {
    label: 'Ativa',
    marker: '✓',
    canResendConfirmation: false,
    canInvite: false,
    inviteCreatesAuth: false,
  },
  pending_confirmation: {
    label: 'Aguardando confirmação',
    marker: '○',
    canResendConfirmation: true,
    canInvite: false,
    inviteCreatesAuth: false,
  },
  existing_confirmed: {
    label: 'Conta existente',
    marker: '○',
    canResendConfirmation: false,
    canInvite: true,
    inviteCreatesAuth: false,
  },
  none: {
    label: 'Sem conta',
    marker: '—',
    canResendConfirmation: false,
    canInvite: true,
    inviteCreatesAuth: true,
  },
  attention: {
    label: 'Requer atenção',
    marker: '!',
    canResendConfirmation: false,
    canInvite: false,
    inviteCreatesAuth: false,
  },
};

export function contactAccountStateView(state: ContactAccountState): ContactAccountStateView {
  return { state, ...VIEWS[state] };
}

export function mapEligibilityToAccountState(input: {
  linkedUserId?: string | null;
  eligible?: boolean | null;
  reasonCode?: string | null;
}): ContactAccountState {
  if (input.linkedUserId) return 'active';
  const reason = String(input.reasonCode ?? '');
  if (reason === 'already_linked') return 'active';
  if (reason === 'pending_email_confirmation') return 'pending_confirmation';
  if (reason === 'invite_existing_confirmed_account' || reason.startsWith('resend_invite_')) {
    return 'existing_confirmed';
  }
  if (reason === 'eligible' && input.eligible) return 'none';
  if (
    reason === 'account_attention'
    || reason === 'email_conflict'
    || reason === 'cpf_conflict'
    || reason === 'account_conflict'
    || reason === 'shared_email'
  ) {
    return 'attention';
  }
  if (!input.eligible) {
    if (reason === 'missing_email' || reason === 'invalid_email' || reason === 'invalid_cpf' || reason === 'inaccessible') {
      return 'attention';
    }
  }
  return input.eligible ? 'none' : 'attention';
}

export function adminAttentionCopy(reasonCode?: string | null) {
  const reason = String(reasonCode ?? '');
  if (reason === 'cpf_conflict') {
    return 'Esta conta requer tratamento administrativo.';
  }
  if (reason === 'email_conflict' || reason === 'account_attention' || reason === 'account_conflict' || reason === 'shared_email') {
    return 'Esta conta requer tratamento administrativo.';
  }
  return 'Esta conta requer tratamento administrativo.';
}

export function isPendingEmailConfirmationReason(reasonCode?: string | null) {
  return String(reasonCode ?? '') === 'pending_email_confirmation';
}

export function usesExistingAuthDelivery(reasonCode?: string | null) {
  const reason = String(reasonCode ?? '');
  return reason.startsWith('resend_invite_') || reason === 'invite_existing_confirmed_account';
}
