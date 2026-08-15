import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20260815005200_multi_checkout_named_holder_contact_first.sql', 'utf8');
const action = fs.readFileSync('src/app/inscricao/actions.ts', 'utf8');
const dashboard = fs.readFileSync('src/lib/dashboard/admin-dashboard-data.ts', 'utf8');

test('checkout named materializa contato, projecao, item e ticket sem trocar proprietario', () => {
  assert.match(migration, /holder_registration_contact_id/);
  assert.match(migration, /public\.is_valid_cpf\(v_cpf\)/);
  assert.match(migration, /insert into public\.registration_contacts/);
  assert.match(migration, /insert into public\.participants/);
  assert.match(migration, /registration_contact_id=v_contact\.id/);
  assert.match(migration, /ownership_status='assigned'/);
  assert.match(migration, /update public\.tickets set participant_id=v_participant\.id/);
  assert.doesNotMatch(migration, /update public\.tickets set owner_user_id/);
});

test('nome isolado cria pendencia e nunca vira identidade canonica', () => {
  assert.match(migration, /insufficient_named_holder_identity/);
  assert.match(migration, /Titular informado sem dados suficientes para identificação/);
  assert.match(migration, /participant_id=null,registration_contact_id=null,ownership_status='unassigned'/);
  assert.doesNotMatch(migration, /where[^;]*full_name=v_name/i);
});

test('normalizacao preserva named em vez de converte-lo em unassigned anonimo', () => {
  assert.match(action, /item\.ownership_mode === 'named'/);
  assert.match(action, /ownership_mode: 'named', ownership_status: 'unassigned'/);
  assert.match(action, /holder_cpf/);
});

test('dashboard nao promove holder_full_name a titular canonico', () => {
  const personName = dashboard.match(/function personName[\s\S]*?\n}/)?.[0] ?? '';
  assert.doesNotMatch(personName, /holder_full_name/);
  assert.match(dashboard, /Nome informado na compra:/);
  assert.match(dashboard, /Titular informado sem dados suficientes para identificação/);
  assert.match(dashboard, /actionLabel: textualHolderOnly \? 'Definir titular'/);
});
