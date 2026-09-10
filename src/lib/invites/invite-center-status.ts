import { isAuthLinkExpired } from '../auth/email-otp-ttl.ts';

export const INVITE_CENTER_STATUSES = [
  'admin_action',
  'falha',
  'cadastro_pendente',
  'expirado',
  'pendente',
  'nao_enviado',
  'pulado',
  'concluido',
] as const;

export type InviteCenterStatus = (typeof INVITE_CENTER_STATUSES)[number];

export const INVITE_CENTER_STATUS_LABEL: Record<InviteCenterStatus, string> = {
  concluido: 'Concluído',
  pendente: 'Aguardando acesso',
  expirado: 'Link expirado',
  falha: 'Falha',
  cadastro_pendente: 'Cadastro incompleto',
  admin_action: 'Ação necessária',
  nao_enviado: 'Não enviado',
  pulado: 'Pulado intencionalmente',
};

export const INVITE_CENTER_CARD_HELP: Partial<Record<InviteCenterStatus, string>> = {
  pendente: 'Recebeu o convite, mas ainda não iniciou o primeiro acesso.',
  cadastro_pendente: 'Iniciou o primeiro acesso, mas ainda precisa concluir o cadastro.',
  expirado: 'O link de acesso venceu antes da conclusão.',
};

export function compactInviteCenterMaskedEmail(value: string | null | undefined) {
  const masked = String(value ?? '').trim();
  const at = masked.indexOf('@');
  if (at < 1) return masked;
  const local = masked.slice(0, at).replace(/\*+$/, '');
  const prefix = (local || masked.slice(0, at)).slice(0, 2);
  if (!prefix) return masked;
  return `${prefix}***@${masked.slice(at + 1)}`;
}

export const INVITE_CENTER_STATUS_TONE: Record<InviteCenterStatus, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  concluido: 'success',
  pendente: 'default',
  expirado: 'warning',
  falha: 'danger',
  cadastro_pendente: 'warning',
  admin_action: 'danger',
  nao_enviado: 'info',
  pulado: 'default',
};

export const INVITE_CENTER_ATTENTION_ORDER: Record<InviteCenterStatus, number> = {
  admin_action: 0,
  falha: 1,
  cadastro_pendente: 2,
  expirado: 3,
  pendente: 4,
  nao_enviado: 5,
  pulado: 6,
  concluido: 7,
};

export type InviteCenterClassifyInput = {
  mixedIntendedOwners: boolean;
  inviteStatus: 'pending' | 'claimed' | 'revoked' | 'expired' | null;
  expiresAt?: string | Date | null;
  authLinkExpiresAt?: string | Date | null;
  authConfirmedAt?: string | Date | null;
  passwordSetupCompletedAt?: string | Date | null;
  now?: Date;
  accountStatus: string | null;
  mustCompleteProfile: boolean;
  mustChangePassword: boolean;
  activationCompletedAt: string | Date | null;
  cadastralIncomplete: boolean;
  jobStatus: 'sent' | 'skipped' | 'failed' | 'pending' | 'processing' | null;
  skipReason?: string | null;
};

function hasTimestamp(value: string | Date | null | undefined) {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime());
}

function isFirstAccessComplete(input: InviteCenterClassifyInput) {
  if (input.mustCompleteProfile || input.mustChangePassword) return false;
  if (input.cadastralIncomplete && input.inviteStatus === 'claimed') return false;
  if (input.activationCompletedAt) return true;
  if (String(input.accountStatus ?? '') === 'active') return true;
  return input.inviteStatus === 'claimed' && hasTimestamp(input.passwordSetupCompletedAt);
}

function isFirstAccessStarted(input: InviteCenterClassifyInput) {
  if (input.inviteStatus === 'claimed') return true;
  return hasTimestamp(input.authConfirmedAt);
}

export function classifyInviteCenterRow(input: InviteCenterClassifyInput): InviteCenterStatus {
  const now = input.now ?? new Date();
  if (input.mixedIntendedOwners) return 'admin_action';

  if (isFirstAccessComplete(input)) return 'concluido';
  if (isFirstAccessStarted(input)) return 'cadastro_pendente';

  const linkExpiresAt = input.authLinkExpiresAt ?? null;
  if (input.inviteStatus === 'pending' && isAuthLinkExpired(linkExpiresAt, now)) return 'expirado';
  if (input.inviteStatus === 'expired') return 'expirado';
  if (input.inviteStatus === 'pending') return 'pendente';

  if (input.jobStatus === 'failed') return 'falha';
  if (input.jobStatus === 'skipped') return 'pulado';
  return 'nao_enviado';
}

export function inviteCenterFirstAccessLabel(status: InviteCenterStatus, cadastralIncompleteBeforeClaim: boolean) {
  if (status === 'concluido') return 'Concluído';
  if (status === 'cadastro_pendente') return 'Primeiro acesso iniciado';
  if (status === 'expirado') return 'Link expirado';
  if (status === 'pendente') {
    return cadastralIncompleteBeforeClaim ? 'Pendente de correção' : 'Ainda não acessou';
  }
  if (status === 'nao_enviado' && cadastralIncompleteBeforeClaim) {
    return 'Pendente de correção';
  }
  if (status === 'admin_action') return 'Exige intervenção';
  if (status === 'falha') return 'Envio não concluído';
  if (status === 'pulado') return 'Não convidado neste ciclo';
  return 'Ainda não acessou';
}

export function canResendInviteCenter(status: InviteCenterStatus) {
  return status === 'pendente' || status === 'expirado' || status === 'falha' || status === 'nao_enviado' || status === 'cadastro_pendente';
}

export function canBulkResendInviteCenter(status: InviteCenterStatus) {
  return status === 'expirado' || status === 'falha';
}

export function inviteCenterResendLabel(status: InviteCenterStatus) {
  if (status === 'cadastro_pendente') return 'Enviar novo link de acesso';
  if (status === 'expirado') return 'Reenviar convite';
  return 'Reenviar convite';
}

export function inviteCenterAdminActionReason(mixedIntendedOwners: boolean) {
  if (mixedIntendedOwners) {
    return 'Mesmo e-mail possui mais de uma conta proprietária pretendida.';
  }
  return 'Identidade, ownership ou e-mail exige intervenção administrativa.';
}

export const INVITE_CENTER_PAGE_SIZES = [25, 50, 100] as const;
export const INVITE_CENTER_BULK_BATCH_SIZE = 5;
export const INVITE_CENTER_BULK_DELAY_MS = 1000;
export const INVITE_CENTER_PERMISSIONS = ['invites.view', 'invites.resend', 'invites.bulk_resend'] as const;

export function inviteCenterEmptyCopy(statusFilter: string, hasAnyRows: boolean, allCompleted = false) {
  if (allCompleted) {
    return {
      title: 'Todos os primeiros acessos foram concluídos. ✓',
      description: 'Não há convites pendentes nesta seleção.',
    };
  }
  if (!hasAnyRows && (!statusFilter || statusFilter === 'all' || statusFilter === 'concluidos')) {
    return {
      title: 'Todos os primeiros acessos foram concluídos. ✓',
      description: 'Não há convites pendentes nesta seleção.',
    };
  }
  if (statusFilter === 'pendentes') {
    return { title: 'Ninguém aguardando acesso.', description: 'Ninguém nesta seleção está com o convite válido ainda não iniciado.' };
  }
  if (statusFilter === 'expirados') {
    return { title: 'Nenhum link de acesso expirado.', description: 'Nenhum convite nesta seleção está com a janela Auth de 24h encerrada.' };
  }
  return { title: 'Nenhum convite encontrado.', description: 'Ajuste os filtros ou a busca para ver outros registros.' };
}
