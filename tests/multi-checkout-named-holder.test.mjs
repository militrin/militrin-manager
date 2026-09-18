import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const legacyMigration = fs.readFileSync('supabase/migrations/20260815005200_multi_checkout_named_holder_contact_first.sql', 'utf8');
const currentMigration = fs.readFileSync('supabase/migrations/20261030000000_named_checkout_textual_holder_only.sql', 'utf8');
const action = fs.readFileSync('src/app/inscricao/actions.ts', 'utf8');
const dashboard = fs.readFileSync('src/lib/dashboard/admin-dashboard-data.ts', 'utf8');
const wizard = fs.readFileSync('src/app/inscricao/[eventSlug]/wizard.tsx', 'utf8');

test('legado 20260815 materializava contato e projecao no checkout nomeado', () => {
  assert.match(legacyMigration, /holder_registration_contact_id/);
  assert.match(legacyMigration, /insert into public\.registration_contacts/);
  assert.match(legacyMigration, /insert into public\.participants/);
  assert.doesNotMatch(legacyMigration, /update public\.tickets set owner_user_id/);
});

test('checkout nomeado atual grava somente holder_full_name e nao cria Cadastro', () => {
  const named = currentMigration.slice(currentMigration.indexOf('create or replace function public.materialize_named_checkout_holders'));
  assert.match(named, /holder_full_name = v_name/);
  assert.match(named, /participant_id = null/);
  assert.match(named, /registration_contact_id = null/);
  assert.match(named, /named_ticket_holder_textual/);
  assert.doesNotMatch(named, /insert into public\.registration_contacts/);
  assert.doesNotMatch(named, /insert into public\.participants/);
  assert.doesNotMatch(named, /is_valid_cpf/);
  assert.doesNotMatch(named, /holder_cpf/);
  assert.doesNotMatch(named, /assert_ticket_holder_contact_available/);
  assert.doesNotMatch(named, /update public\.tickets[\s\S]{0,80}owner_user_id\s*=/);
  assert.doesNotMatch(named, /intended_owner_contact_id/);
});

test('normalizacao preserva named e remove identidade do titular textual', () => {
  assert.match(action, /item\.ownership_mode === 'named'/);
  assert.match(action, /ownership_mode: 'named', ownership_status: 'unassigned'/);
  assert.match(action, /holder_full_name: buyerFullName/);
  assert.match(action, /holder_cpf: null/);
  assert.doesNotMatch(wizard, /CPF do titular/);
  assert.doesNotMatch(wizard, /placeholder="E-mail \(opcional\)"/);
});

test('dashboard trata holder_full_name como titular canonico', () => {
  const personName = dashboard.match(/function personName[\s\S]*?\n}/)?.[0] ?? '';
  assert.match(personName, /canonicalHolderName/);
  assert.match(dashboard, /hasCanonicalHolderName\(item\.holder_full_name\)/);
  assert.doesNotMatch(dashboard, /Titular informado sem dados suficientes para identificação/);
  assert.doesNotMatch(dashboard, /textualHolderOnly/);
});
