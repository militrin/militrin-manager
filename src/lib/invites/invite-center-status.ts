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
  pendente: 'Pendente',
  expirado: 'Expirado',
  falha: 'Falha de envio',
  cadastro_pendente: 'Cadastro pendente',
  admin_action: 'Ação administrativa',
  nao_enviado: 'Não enviado',
  pulado: 'Pulado intencionalmente',
};

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
  expiresAt: string | Date | null;
  now?: Date;
  accountStatus: string | null;
  mustCompleteProfile: boolean;
  mustChangePassword: boolean;
  activationCompletedAt: string | Date | null;
  cadastralIncomplete: boolean;
  jobStatus: 'sent' | 'skipped' | 'failed' | 'pending' | 'processing' | null;
  skipReason?: string | null;
};

function isExpired(expiresAt: string | Date | null, now: Date) {
  if (!expiresAt) return false;
  const value = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return !Number.isNaN(value.getTime()) && value.getTime() <= now.getTime();
}

function isClaimedComplete(input: InviteCenterClassifyInput) {
  if (input.mustCompleteProfile || input.mustChangePassword || input.cadastralIncomplete) return false;
  if (input.activationCompletedAt) return true;
  return String(input.accountStatus ?? '') === 'active';
}

export function classifyInviteCenterRow(input: InviteCenterClassifyInput): InviteCenterStatus {
  const now = input.now ?? new Date();
  if (input.mixedIntendedOwners) return 'admin_action';

  if (input.inviteStatus === 'claimed') {
    return isClaimedComplete(input) ? 'concluido' : 'cadastro_pendente';
  }

  if (input.inviteStatus === 'pending' && isExpired(input.expiresAt, now)) return 'expirado';
  if (input.inviteStatus === 'expired') return 'expirado';
  if (input.inviteStatus === 'pending') return 'pendente';

  if (input.jobStatus === 'failed') return 'falha';
  if (input.jobStatus === 'skipped') return 'pulado';
  return 'nao_enviado';
}

export function inviteCenterFirstAccessLabel(status: InviteCenterStatus, cadastralIncompleteBeforeClaim: boolean) {
  if (status === 'concluido') return 'Concluído';
  if (status === 'cadastro_pendente') return 'Cadastro pendente';
  if (status === 'pendente' || status === 'expirado') {
    return cadastralIncompleteBeforeClaim
      ? 'Pendente de correção no primeiro acesso'
      : 'Ainda não acessou';
  }
  if (status === 'nao_enviado' && cadastralIncompleteBeforeClaim) {
    return 'Pendente de correção no primeiro acesso';
  }
  if (status === 'admin_action') return 'Exige intervenção';
  if (status === 'falha') return 'Envio não concluído';
  if (status === 'pulado') return 'Não convidado neste ciclo';
  return 'Ainda não acessou';
}

export function canResendInviteCenter(status: InviteCenterStatus) {
  return status === 'pendente' || status === 'expirado' || status === 'falha' || status === 'nao_enviado';
}

export function canBulkResendInviteCenter(status: InviteCenterStatus) {
  return status === 'expirado' || status === 'falha';
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
    return { title: 'Nenhum convite pendente.', description: 'Ninguém nesta seleção está aguardando o primeiro acesso.' };
  }
  return { title: 'Nenhum convite encontrado.', description: 'Ajuste os filtros ou a busca para ver outros registros.' };
}
