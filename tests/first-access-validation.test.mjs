import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  FIRST_ACCESS_PROFILE_FIELDS,
  validateFirstAccessProfile,
} from '../src/lib/account/first-access-validation.ts';

const validProfile = {
  full_name: 'Maria da Silva',
  cpf: '529.982.247-25',
  birth_date: '31/12/1990',
  gender: 'female',
  phone: '(49) 99999-9999',
  email: 'maria@example.com',
  city: 'Itapiranga',
};

test('validador canonico aceita e normaliza todos os campos obrigatorios', () => {
  const result = validateFirstAccessProfile(validProfile);
  assert.equal(result.success, true);
  assert.deepEqual(result.fieldErrors, {});
  assert.equal(result.values.cpf, '52998224725');
  assert.equal(result.values.birth_date, '1990-12-31');
  assert.equal(result.values.phone, '49999999999');
  assert.deepEqual(FIRST_ACCESS_PROFILE_FIELDS, ['full_name', 'cpf', 'birth_date', 'gender', 'phone', 'email', 'city']);
});

test('cidade preenchida elimina imediatamente a pendencia sem depender da lista editavel inicial', () => {
  const missing = validateFirstAccessProfile({ ...validProfile, city: '' });
  assert.equal(missing.fieldErrors.city, 'Informe sua cidade.');
  const filled = validateFirstAccessProfile({ ...validProfile, city: 'Itapiranga' });
  assert.equal(filled.fieldErrors.city, undefined);
  assert.equal(filled.success, true);
});

test('rejeita CPF, data real, genero, telefone e email invalidos', () => {
  const result = validateFirstAccessProfile({
    ...validProfile,
    cpf: '111.111.111-11',
    birth_date: '31/02/1990',
    gender: '',
    phone: '123',
    email: 'sem-arroba',
  });
  assert.deepEqual(Object.keys(result.fieldErrors).sort(), ['birth_date', 'cpf', 'email', 'gender', 'phone']);
});

test('valores legados validos de genero continuam aceitos e valores desconhecidos nao', () => {
  for (const gender of ['male', 'female', 'other', 'prefer_not_to_say']) {
    assert.equal(validateFirstAccessProfile({ ...validProfile, gender }).fieldErrors.gender, undefined);
  }
  assert.ok(validateFirstAccessProfile({ ...validProfile, gender: 'masculino' }).fieldErrors.gender);
});

test('server action valida formulario e senha antes da primeira mutacao', async () => {
  const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
  const validationAt = action.indexOf('validateFirstAccessProfile({');
  const passwordValidationAt = action.indexOf("passwordErrors.new_password");
  const claimAt = action.indexOf("rpc('claim_participant_account_invite'");
  const passwordMutationAt = action.indexOf('supabase.auth.updateUser');
  const profileMutationAt = action.indexOf('upsertCustomerProfileCompat(supabase');
  assert.ok(validationAt > 0 && validationAt < claimAt);
  assert.ok(passwordValidationAt > validationAt && passwordValidationAt < claimAt);
  assert.ok(passwordMutationAt < profileMutationAt && profileMutationAt < claimAt);
  assert.doesNotMatch(action, /privacyAccepted/);
});

test('frontend usa a validacao atual, limpa erros ao editar e exibe erros por campo', async () => {
  const form = await readFile(new URL('../src/app/primeiro-acesso/FirstAccessForm.tsx', import.meta.url), 'utf8');
  assert.match(form, /const currentValidation = validateFirstAccessProfile/);
  assert.match(form, /setMessage\(null\)/);
  assert.match(form, /delete next\[field\]/);
  assert.match(form, /result\.field_errors/);
  assert.match(form, /aria-invalid/);
});
