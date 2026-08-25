import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PASSWORD_RECOVERY_STATE_SECRET = 'test-only-secret-with-enough-entropy';
const { createPasswordRecoveryState, verifyPasswordRecoveryState } = await import('../src/lib/account/password-recovery-state.ts');

test('estado recovery assinado e valido dentro do prazo', () => {
  const now = Date.UTC(2026, 7, 24, 12);
  const token = createPasswordRecoveryState('pessoa@example.com', now);
  assert.equal(verifyPasswordRecoveryState(token, 'PESSOA@example.com', now + 30_000), true);
});

test('estado adulterado, expirado ou ausente e rejeitado', () => {
  const now = Date.UTC(2026, 7, 24, 12);
  const token = createPasswordRecoveryState('pessoa@example.com', now);
  assert.equal(verifyPasswordRecoveryState(`${token}x`, 'pessoa@example.com', now), false);
  assert.equal(verifyPasswordRecoveryState(token, 'outra@example.com', now), false);
  assert.equal(verifyPasswordRecoveryState(token, 'pessoa@example.com', now + 60 * 60 * 1000 + 1), false);
  assert.equal(verifyPasswordRecoveryState('', 'pessoa@example.com', now), false);
});
