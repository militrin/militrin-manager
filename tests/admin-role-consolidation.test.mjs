import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260879000000_consolidate_admin_roles.sql', import.meta.url), 'utf8');
const docs = await readFile(new URL('../docs/rbac-audit.md', import.meta.url), 'utf8');
const teamPage = await readFile(new URL('../src/app/configuracoes/equipe/page.tsx', import.meta.url), 'utf8');
const addMember = await readFile(new URL('../src/app/configuracoes/equipe/add-member-modal.tsx', import.meta.url), 'utf8');

test('seis funcoes finais e equivalencias antigas estao declaradas', () => {
  for (const role of ['owner', 'administrator', 'operational', 'finance', 'marketing', 'viewer']) assert.match(migration + docs, new RegExp(role));
  for (const legacy of ['manager', 'inventory', 'checkin', 'kit_delivery', 'support']) assert.match(migration, new RegExp(`'${legacy}'`));
  assert.match(migration, /\('support', 'operational'\)/);
});

test('membros migram antes da desativacao e overrides existentes ficam intactos', () => {
  const roleUpdate = migration.indexOf('update public.admin_users au set role_id');
  const deactivate = migration.indexOf('update public.admin_roles set is_active = false');
  assert.ok(roleUpdate >= 0 && roleUpdate < deactivate);
  assert.doesNotMatch(migration, /insert into public\.admin_user_permission_overrides/);
  assert.doesNotMatch(migration, /delete from public\.admin_user_permission_overrides/);
  assert.match(migration, /resolve_user_permission/);
});

test('resolve_user_permission e Owner especial nao sao alterados', () => {
  assert.doesNotMatch(migration, /create or replace function public\.resolve_user_permission/);
  assert.match(migration, /Owner continua especial em resolve_user_permission/);
});

test('Operacional nao recebe acoes destrutivas ou financeiras', () => {
  const operational = migration.slice(migration.indexOf("('operational', 'dashboard.people.view')"), migration.indexOf("('finance', 'dashboard.finance.view')"));
  for (const allowed of ['participants.view', 'participants.edit_basic', 'checkin.scan', 'kits.deliver', 'wristbands.link', 'inventory.change_participant_shirt', 'store.deliver']) assert.match(operational, new RegExp(allowed.replaceAll('.', '\\.')));
  for (const denied of ['checkin.undo', 'kits.undo_delivery', 'inventory.adjust', 'tickets.transfer_ownership', 'finance.', 'team.']) assert.doesNotMatch(operational, new RegExp(denied.replaceAll('.', '\\.')));
});

test('Financeiro Marketing e Visualizador nao recebem areas alheias', () => {
  const finance = migration.slice(migration.indexOf("('finance', 'dashboard.finance.view')"), migration.indexOf("('marketing', 'participants.view')"));
  const marketing = migration.slice(migration.indexOf("('marketing', 'participants.view')"), migration.indexOf("('viewer', 'dashboard.people.view')"));
  const viewerStart = migration.indexOf("('viewer', 'dashboard.people.view')");
  const viewer = migration.slice(viewerStart, migration.indexOf('insert into public.admin_role_permissions', viewerStart));
  assert.doesNotMatch(finance, /events\.|inventory\.|checkin\.|team\./);
  assert.doesNotMatch(marketing, /finance\.|checkin\.|kits\.|team\./);
  assert.doesNotMatch(marketing, /dashboard\.[a-z_]+\.view/);
  assert.match(viewer, /dashboard\.people\.view/);
  assert.match(viewer, /dashboard\.operations\.view/);
  assert.doesNotMatch(viewer, /finance\.|inventory\.|checkin\.|kits\.|team\.|events\.(create|edit|publish)/);
});

test('list_admin_roles oferece somente as seis funcoes finais', () => {
  const fn = migration.slice(migration.indexOf('create or replace function public.list_admin_roles()'), migration.indexOf('revoke all on function public.list_admin_roles()'));
  assert.match(fn, /ar\.code in \('owner', 'administrator', 'operational', 'finance', 'marketing', 'viewer'\)/);
  assert.match(fn, /ar\.is_active = true/);
  for (const legacy of ['manager', 'inventory', 'checkin', 'kit_delivery', 'support']) assert.doesNotMatch(fn, new RegExp(`'${legacy}'`));
});

test('telas de equipe consomem roles ativas retornadas pelas RPCs', () => {
  assert.match(teamPage, /supabase\.rpc\('list_admin_roles'\)/);
  assert.match(teamPage, /roleOptions = roles\.map/);
  assert.match(addMember, /roleOptions\.map/);
  assert.doesNotMatch(teamPage + addMember, /Manager|Inventory|Check-in|Kit Delivery|Support/);
});
