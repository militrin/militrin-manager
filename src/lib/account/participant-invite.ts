import 'server-only';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/admin';
import { evaluateParticipantInviteAccess } from '@/lib/account/participant-invite-policy';

type AuthenticatedInviteUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown>;
};

export type ParticipantInviteContext = {
  valid: boolean;
  reason?: 'not_found' | 'inactive' | 'wrong_session' | 'participant_not_found' | 'participant_conflict';
  participant: Record<string, unknown> | null;
  userResolvableFields: string[];
  openIssueIds: string[];
  requiresPasswordSetup: boolean;
};

const emptyContext = (reason: ParticipantInviteContext['reason']): ParticipantInviteContext => ({
  valid: false,
  reason,
  participant: null,
  userResolvableFields: [],
  openIssueIds: [],
  requiresPasswordSetup: false,
});

export function getParticipantInviteFailureCopy(reason: ParticipantInviteContext['reason']) {
  if (reason === 'wrong_session') {
    return {
      title: 'Este convite pertence a outra sessão',
      description: 'A conta autenticada não corresponde à conta explicitamente vinculada ao convite.',
      actionMessage: 'Este convite não pertence à sessão autenticada. Entre com a conta vinculada ao convite.',
    };
  }
  if (reason === 'participant_conflict') {
    return {
      title: 'Cadastro vinculado a outra conta',
      description: 'O participante deste convite está vinculado a outra conta e exige revisão administrativa.',
      actionMessage: 'O cadastro deste convite está vinculado a outra conta.',
    };
  }
  return {
    title: 'Este convite não está mais ativo',
    description: 'O convite não foi encontrado, expirou ou foi desativado.',
    actionMessage: 'Este convite não está mais ativo. Solicite ao organizador que verifique o cadastro.',
  };
}

export async function getParticipantInviteContext(inviteId: string, user: AuthenticatedInviteUser): Promise<ParticipantInviteContext> {
  if (!inviteId) return emptyContext('not_found');
  const admin = createServiceRoleSupabaseClient();
  const { data: invite, error } = await admin.from('participant_account_invites').select('*').eq('id', inviteId).maybeSingle();
  if (error || !invite) return emptyContext('not_found');

  const { data: participant } = await admin.from('participants')
    .select('id,event_id,user_id,registration_contacts(full_name,cpf,birth_date,gender,phone,email,city)')
    .eq('id', invite.participant_id).maybeSingle();
  if (!participant) return emptyContext('participant_not_found');
  const registrationContact = Array.isArray(participant.registration_contacts)
    ? participant.registration_contacts[0]
    : participant.registration_contacts;
  const canonicalParticipant = { ...participant, ...(registrationContact ?? {}) };

  const accessFailure = evaluateParticipantInviteAccess({
    inviteId,
    inviteStatus: String(invite.status ?? ''),
    expiresAt: invite.expires_at ? String(invite.expires_at) : null,
    inviteEmail: invite.email ? String(invite.email) : null,
    authUserId: invite.auth_user_id ? String(invite.auth_user_id) : null,
    claimedUserId: invite.claimed_user_id ? String(invite.claimed_user_id) : null,
    participantUserId: participant.user_id ? String(participant.user_id) : null,
    userId: user.id,
    userEmail: user.email ?? null,
    metadataInviteId: String(user.user_metadata?.participant_invite_id ?? '') || null,
  });
  if (accessFailure) return emptyContext(accessFailure);

  const { data: issues } = await admin.from('participant_data_issues').select('id,field_code,resolution_scope').eq('participant_id', participant.id).eq('status', 'open');
  return {
    valid: true,
    participant: canonicalParticipant as Record<string, unknown>,
    userResolvableFields: [...new Set((issues ?? []).filter((issue) => issue.resolution_scope === 'user_resolvable').map((issue) => String(issue.field_code)))],
    openIssueIds: (issues ?? []).map((issue) => String(issue.id)),
    requiresPasswordSetup: Boolean(invite.requires_password_setup) && !invite.password_setup_completed_at,
  };
}
