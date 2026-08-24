import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBuyerRequirements } from '../src/lib/checkout/buyer-requirements.ts';

const complete = {
  full_name: 'Pessoa Teste', cpf: '12345678901', birth_date: '01/01/1990',
  gender: 'female', phone: '41999999999', city: 'Curitiba',
};

test('complete data and pending consent are distinct states', () => {
  const state = resolveBuyerRequirements({ ...complete, privacyAlreadyAccepted: false, privacyAcceptedNow: false });
  assert.equal(state.dataComplete, true);
  assert.equal(state.missingConsent, true);
  assert.equal(state.canRevealCompleteData, false);
  assert.equal(state.canContinue, false);
});

test('checking consent reveals complete data and enables continuation', () => {
  const state = resolveBuyerRequirements({ ...complete, privacyAlreadyAccepted: false, privacyAcceptedNow: true });
  assert.equal(state.canRevealCompleteData, true);
  assert.equal(state.canContinue, true);
});

test('valid existing consent does not create another barrier', () => {
  const state = resolveBuyerRequirements({ ...complete, privacyAlreadyAccepted: true, privacyAcceptedNow: false });
  assert.equal(state.missingConsent, false);
  assert.equal(state.canRevealCompleteData, true);
  assert.equal(state.canContinue, true);
});

test('missing data remains incomplete independently of consent', () => {
  const pending = resolveBuyerRequirements({ ...complete, city: '', privacyAlreadyAccepted: false, privacyAcceptedNow: false });
  const accepted = resolveBuyerRequirements({ ...complete, city: '', privacyAlreadyAccepted: true, privacyAcceptedNow: false });
  assert.deepEqual(pending.missingRequiredData, ['city']);
  assert.equal(pending.missingConsent, true);
  assert.equal(accepted.missingConsent, false);
  assert.equal(accepted.canContinue, false);
});

test('new and legacy partial profiles expose only their actual missing fields', () => {
  const fresh = resolveBuyerRequirements({ full_name: '', cpf: '', birth_date: '', gender: '', phone: '', city: '', privacyAlreadyAccepted: false, privacyAcceptedNow: false });
  const legacy = resolveBuyerRequirements({ ...complete, phone: '123', city: '', privacyAlreadyAccepted: true, privacyAcceptedNow: false });
  assert.equal(fresh.missingRequiredData.length, 6);
  assert.deepEqual(legacy.missingRequiredData, ['phone', 'city']);
});
