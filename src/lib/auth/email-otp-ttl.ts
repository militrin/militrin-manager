// TTL canônico do link de e-mail Auth (Invite + Magic Link).
// Confirmado em produção (config pull): auth.email.otp_expiry = 86400.
// A Central NÃO consulta auth.users por linha: persiste auth_email_sent_at
// no convite interno e deriva auth_link_expires_at desta constante.
export const AUTH_EMAIL_OTP_EXPIRY_SECONDS = 86_400;
export const AUTH_EMAIL_OTP_EXPIRY_HOURS = 24;
export const AUTH_EMAIL_OTP_EXPIRY_LABEL = '24 horas após o envio';

export function authLinkExpiresAtFromSend(sentAt: Date | string) {
  const start = sentAt instanceof Date ? sentAt.getTime() : new Date(sentAt).getTime();
  if (Number.isNaN(start)) return null;
  return new Date(start + AUTH_EMAIL_OTP_EXPIRY_SECONDS * 1000);
}

export function isAuthLinkExpired(expiresAt: Date | string | null | undefined, now: Date = new Date()) {
  if (!expiresAt) return false;
  const value = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return !Number.isNaN(value.getTime()) && value.getTime() <= now.getTime();
}
