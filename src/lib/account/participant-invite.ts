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
  anchorKind: 'participant' | 'contact';
};

const emptyContext = (reason: ParticipantInviteContext['reason']): ParticipantInviteContext => ({
  valid: false,
  reason,
  participant: null,
  userResolvableFields: [],
  openIssueIds: [],
  requiresPasswordSetup: false,
  anchorKind: 'participant',
});

export function getParticipantInviteFailureCopy(reason: ParticipantInviteContext['reason']) {
  if (reason === 'wrong_session') {
    return {
      title: 'Este convite pertence a outra sessão',
      description: 'A conta autenticada não corresponde à conta explicitamente vinculada ao convite.',
      actionMessage: 'Este convite não pertence à sessão autenticada. Entre com a conta vinculada ao convite.',
      actionHref: '/entrar',
      actionLabel: 'Entrar com a conta correta',
    };
  }
  if (reason === 'participant_conflict') {
    return {
      title: 'Cadastro vinculado a outra conta',
      description: 'O participante deste convite está vinculado a outra conta e exige revisão administrativa.',
      actionMessage: 'O cadastro deste convite está vinculado a outra conta.',
      actionHref: '/',
      actionLabel: 'Voltar',
    };
  }
  return {
    title: 'Este convite não está mais ativo',
    description: 'O convite não foi encontrado, expirou ou foi desativado. Solicite um novo envio pelo e-mail do cadastro; o token de acesso só existe no e-mail do provedor de autenticação, nunca nesta tela.',
    actionMessage: 'Este convite não está mais ativo. Solicite um novo convite pelo e-mail cadastrado.',
    actionHref: '/primeiro-acesso/reenviar',
    actionLabel: 'Solicitar novo convite',
  };
}

export async function getParticipantInviteContext(inviteId: string, user: AuthenticatedInviteUser): Promise<ParticipantInviteContext> {
  if (!inviteId) return emptyContext('not_found');
  const admin = createServiceRoleSupabaseClient();
  const { data: invite, error } = await admin.from('participant_account_invites').select('*').eq('id', inviteId).maybeSingle();
  if (error || !invite) return emptyContext('not_found');

  const isContactInvite = Boolean(invite.registration_contact_id) && !invite.participant_id;
  const { data: participant } = isContactInvite
    ? { data: null }
    : await admin.from('participants')
      .select('id,event_id,user_id,registration_contacts(full_name,cpf,birth_date,gender,phone,email,city)')
      .eq('id', invite.participant_id).maybeSingle();
  const { data: directContact } = isContactInvite
    ? await admin.from('registration_contacts').select('id,user_id,full_name,cpf,birth_date,gender,phone,email,city').eq('id', invite.registration_contact_id).maybeSingle()
    : { data: null };
  if (!participant && !directContact) return emptyContext('participant_not_found');
  const registrationContact = participant
    ? (Array.isArray(participant.registration_contacts) ? participant.registration_contacts[0] : participant.registration_contacts)
    : directContact;
  const canonicalParticipant = participant ? { ...participant, ...(registrationContact ?? {}) } : directContact!;

  const accessFailure = evaluateParticipantInviteAccess({
    inviteId,
    inviteStatus: String(invite.status ?? ''),
    expiresAt: invite.expires_at ? String(invite.expires_at) : null,
    inviteEmail: invite.email ? String(invite.email) : null,
    authUserId: invite.auth_user_id ? String(invite.auth_user_id) : null,
    claimedUserId: invite.claimed_user_id ? String(invite.claimed_user_id) : null,
    participantUserId: canonicalParticipant.user_id ? String(canonicalParticipant.user_id) : null,
    userId: user.id,
    userEmail: user.email ?? null,
    metadataInviteId: String(user.user_metadata?.participant_invite_id ?? '') || null,
  });
  if (accessFailure) return emptyContext(accessFailure);

  // BUG CORRIGIDO: convites ancorados em registration_contact (o caminho
  // canonico do import "contact-first") tinham `issues` fixado em [] aqui --
  // nunca consultavam participant_data_issues de verdade. Resultado real:
  // resolve_ticket_data_issues/finalize_imported_ticket_after_issue_resolution
  // (em primeiro-acesso/actions.ts) ficavam com openIssueIds sempre vazio e
  // NUNCA eram chamadas, entao nenhuma pendencia criada por dado ausente na
  // importacao (genero, CPF, data de nascimento, telefone, e-mail, cidade)
  // era reavaliada quando o proprio usuario preenchia o dado no primeiro
  // acesso -- a pendencia ficava "open" para sempre, mesmo com o cadastro
  // corrigido. participant_data_issues ja grava registration_contact_id em
  // todo fluxo de criacao atual (ver contact_first_import_phase2 em diante),
  // entao consultar por esse campo e o equivalente correto ao `participant_id`
  // usado no ramo participant-anchored abaixo.
  const { data: issues } = participant
    ? await admin.from('participant_data_issues').select('id,field_code,resolution_scope').eq('participant_id', participant.id).eq('status', 'open')
    : await admin.from('participant_data_issues').select('id,field_code,resolution_scope').eq('registration_contact_id', invite.registration_contact_id).eq('status', 'open');
  return {
    valid: true,
    participant: canonicalParticipant as Record<string, unknown>,
    userResolvableFields: [...new Set((issues ?? []).filter((issue) => issue.resolution_scope === 'user_resolvable').map((issue) => String(issue.field_code)))],
    openIssueIds: (issues ?? []).map((issue) => String(issue.id)),
    requiresPasswordSetup: Boolean(invite.requires_password_setup) && !invite.password_setup_completed_at,
    anchorKind: isContactInvite ? 'contact' : 'participant',
  };
}
