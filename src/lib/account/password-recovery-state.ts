import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const RECOVERY_STATE_TTL_MS = 60 * 60 * 1000;

function secret() {
  const value = process.env.PASSWORD_RECOVERY_STATE_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error('Segredo do estado de recuperacao nao configurado.');
  return value;
}

function signature(payload: string) {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function emailFingerprint(email: string) {
  return createHmac('sha256', secret()).update(String(email).trim().toLowerCase()).digest('base64url');
}

export function createPasswordRecoveryState(email: string, nowMs = Date.now()) {
  const payload = `${nowMs}.${randomBytes(18).toString('base64url')}.${emailFingerprint(email)}`;
  return `${payload}.${signature(payload)}`;
}

export function verifyPasswordRecoveryState(token: string, email: string, nowMs = Date.now()) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 4) return false;
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expected = Buffer.from(signature(payload));
  const received = Buffer.from(parts[3]);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
  const expectedEmail = Buffer.from(emailFingerprint(email));
  const receivedEmail = Buffer.from(parts[2]);
  if (expectedEmail.length !== receivedEmail.length || !timingSafeEqual(expectedEmail, receivedEmail)) return false;
  const issuedAt = Number(parts[0]);
  return Number.isFinite(issuedAt) && issuedAt <= nowMs && nowMs - issuedAt <= RECOVERY_STATE_TTL_MS;
}
