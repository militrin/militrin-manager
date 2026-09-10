import 'server-only';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/admin';
import { authLinkExpiresAtFromSend } from '@/lib/auth/email-otp-ttl';
import { appBaseUrl } from '@/lib/urls/app-base-url';

// Nucleo reutilizavel do envio/reenvio de convite de primeiro acesso --
// modulo plano (server-only, NUNCA "use server") de proposito: nao vira uma
// Server Action por si so, entao nada aqui e' diretamente chamavel do
// cliente sem passar pela autorizacao de quem importa. inviteCadastroFirstAccessAction
// (src/app/cadastros/actions.ts, admin, exige participants.edit_basic) e
// requestFirstAccessInviteResendAction (src/app/primeiro-acesso/reenviar/actions.ts,
// publico, anti-enumeracao + rate limit nativo do Supabase) sao os dois
// unicos wrappers "use server" que chamam isto -- cada um com seu proprio
// modelo de autorizacao, reusando o MESMO mecanismo canonico de envio.
export function firstAccessInviteRedirect(inviteId: string) {
  // Mesmo helper canonico usado por signUp/resetPasswordForEmail
  // (src/lib/urls/app-base-url.ts) -- em producao ele ignora a variavel de
  // ambiente publica de URL do app e sempre resolve pro dominio real
  // (https://www.militrin.com.br). Ler aquela variavel direto aqui (como
  // antes) fazia o link de convite cair em http://localhost:3000 sempre que
  // ela estivesse ausente/errada no runtime de producao -- o Supabase Auth
  // entao recusa silenciosamente esse redirect_to (fora da allowlist do
  // projeto) e cai no Site URL configurado, que os usuarios percebiam como
  // "o link me leva pro login".
  const appUrl = appBaseUrl();
  const destination = `/primeiro-acesso?invite=${encodeURIComponent(inviteId)}&next=${encodeURIComponent('/minha-conta/ingressos')}`;
  return `${appUrl}/auth/callback?next=${encodeURIComponent(destination)}`;
}

export async function requireFirstAccessPassword(inviteId: string) {
  const admin = createServiceRoleSupabaseClient();
  const result = await admin.from('participant_account_invites')
    .update({ requires_password_setup: true, updated_at: new Date().toISOString() })
    .eq('id', inviteId)
    .is('password_setup_completed_at', null)
    .select('id')
    .maybeSingle();
  return result.error;
}

export async function markInvitedAccountPending(userId: string, mustChangePassword = true) {
  const admin = createServiceRoleSupabaseClient();
  const result = await admin.from('customer_profiles').upsert({
    user_id: userId,
    account_status: 'pending_activation',
    must_change_password: mustChangePassword,
    must_complete_profile: true,
  }, { onConflict: 'user_id' });
  return result.error;
}

export async function dispatchFirstAccessEmail(input: { inviteId: string; email: string; reasonCode: string }) {
  const admin = createServiceRoleSupabaseClient();
  const isResend = input.reasonCode.startsWith('resend_invite_');
  const redirectTo = firstAccessInviteRedirect(input.inviteId);

  const passwordRequirementError = await requireFirstAccessPassword(input.inviteId);
  if (passwordRequirementError) {
    return { error: passwordRequirementError, authUserId: null as string | null, resent: isResend };
  }

  const { data: invitePerson } = await admin.from('participant_account_invites')
    .select('auth_user_id,password_setup_completed_at,registration_contacts(full_name),participants(registration_contacts(full_name))')
    .eq('id', input.inviteId).maybeSingle();
  const directContactRelation = Array.isArray(invitePerson?.registration_contacts) ? invitePerson.registration_contacts[0] : invitePerson?.registration_contacts;
  const participantRelation = Array.isArray(invitePerson?.participants) ? invitePerson?.participants[0] : invitePerson?.participants;
  const contactRelation = Array.isArray(participantRelation?.registration_contacts) ? participantRelation?.registration_contacts[0] : participantRelation?.registration_contacts;
  const canonicalFullName = String(directContactRelation?.full_name ?? contactRelation?.full_name ?? '').trim();

  if (isResend) {
    const result = await admin.auth.signInWithOtp({
      email: input.email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
    });
    if (!result.error) {
      const stampError = await stampInviteAuthEmailSent(input.inviteId);
      if (stampError) return { error: stampError, authUserId: null as string | null, resent: true };
    }
    if (!result.error && invitePerson?.auth_user_id) {
      const pendingError = await markInvitedAccountPending(
        String(invitePerson.auth_user_id),
        !invitePerson.password_setup_completed_at,
      );
      if (pendingError) return { error: pendingError, authUserId: null as string | null, resent: true };
    }
    return { error: result.error, authUserId: null as string | null, resent: true };
  }

  const result = await admin.auth.admin.inviteUserByEmail(input.email, {
    redirectTo,
    data: { participant_invite_id: input.inviteId, ...(canonicalFullName ? { full_name: canonicalFullName } : {}) },
  });
  if (!result.error) {
    const stampError = await stampInviteAuthEmailSent(input.inviteId);
    if (stampError) return { error: stampError, authUserId: result.data.user?.id ?? null, resent: false };
  }
  return { error: result.error, authUserId: result.data.user?.id ?? null, resent: false };
}

export async function stampInviteAuthEmailSent(inviteId: string) {
  const admin = createServiceRoleSupabaseClient();
  const sentAt = new Date();
  const expiresAt = authLinkExpiresAtFromSend(sentAt);
  const result = await admin.from('participant_account_invites')
    .update({
      auth_email_sent_at: sentAt.toISOString(),
      auth_link_expires_at: expiresAt ? expiresAt.toISOString() : null,
      updated_at: sentAt.toISOString(),
    })
    .eq('id', inviteId);
  return result.error;
}

export async function markFirstAccessAuthConfirmed(userId: string, inviteId?: string | null) {
  if (!userId) return null;
  const admin = createServiceRoleSupabaseClient();
  const now = new Date().toISOString();
  let query = admin.from('participant_account_invites')
    .update({ auth_confirmed_at: now, updated_at: now })
    .is('auth_confirmed_at', null)
    .is('password_setup_completed_at', null);
  if (inviteId) {
    query = query.eq('id', inviteId);
  } else {
    query = query.or(`auth_user_id.eq.${userId},claimed_user_id.eq.${userId}`);
  }
  const result = await query;
  return result.error;
}
