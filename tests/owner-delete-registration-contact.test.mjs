import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync('supabase/migrations/20260894000000_owner_delete_empty_registration_contact.sql', 'utf8');
const page = fs.readFileSync('src/app/cadastros/[id]/editar/page.tsx', 'utf8');
const actions = fs.readFileSync('src/app/cadastros/[id]/editar/actions.ts', 'utf8');
const button = fs.readFileSync('src/app/cadastros/[id]/editar/delete-cadastro-button.tsx', 'utf8');

test('only the organization Owner receives and can execute deletion', () => {
  assert.match(page, /organizationContext\.isOrgOwner/);
  assert.match(actions, /!context\.organization\?\.id \|\| !context\.isOrgOwner/);
  assert.match(migration, /is_organization_owner\(v_actor, v_contact\.organization_id\)/);
});

test('deletion requires exact name and a reason', () => {
  assert.match(button, /digite o nome completo/);
  assert.match(migration, /lower\(trim\(coalesce\(p_confirmation/);
  assert.match(migration, /Informe o motivo da exclusao/);
});

test('linked operational and account records block destructive deletion', () => {
  for (const dependency of ['v_contact.user_id', 'public.participants', 'public.order_items', 'public.store_orders', 'public.sponsors']) {
    assert.match(migration, new RegExp(dependency.replaceAll('.', '\\.')));
  }
  assert.match(migration, /delete from public\.registration_contacts/);
});

test('successful deletion is audited and returns to Cadastros', () => {
  assert.match(migration, /registration_contact_deleted/);
  assert.match(button, /router\.replace\("\/cadastros"\)/);
});
