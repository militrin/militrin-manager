import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readUtf8(relativePath) {
  return (await readFile(new URL(relativePath, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
}

const permissions = await readUtf8('../src/lib/admin/permissions.ts');
const requestAuth = await readUtf8('../src/lib/auth/request-auth.ts');
const panelAccess = await readUtf8('../src/lib/admin/panel-access.ts');
const landing = await readUtf8('../src/lib/navigation/admin-landing.ts');
const sidebarActions = await readUtf8('../src/components/dashboard/sidebar-actions.ts');
const migration = await readUtf8('../supabase/migrations/20261014000000_current_user_permission_codes.sql');
const minhaContaLayout = await readUtf8('../src/app/minha-conta/layout.tsx');

test('T7 sidebar usa o mapa agregado, nao RPC por codigo', () => {
  assert.match(sidebarActions, /getCurrentPermissionMap\(ADMIN_NAV_PERMISSION_CODES\)/);
  assert.doesNotMatch(sidebarActions, /current_user_has_permission/);
});

test('T8 landing usa o mapa agregado e nao carrega capacidades sem permissao admin', () => {
  assert.match(landing, /getCurrentPermissionMap\(ADMIN_NAV_PERMISSION_CODES\)/);
  assert.match(landing, /hasAdministrativeAccess/);
  assert.doesNotMatch(landing, /current_user_has_permission/);
});

test('T9 context action reutiliza getCurrentPermissionMap', () => {
  assert.match(sidebarActions, /getSidebarContextAction/);
  assert.match(sidebarActions, /getCurrentPermissionMap\(ADMIN_NAV_PERMISSION_CODES\)/);
});

test('T10 getUser e request-scoped via cache do React, sem getSession', () => {
  assert.match(requestAuth, /cache\(async \(\): Promise<AuthResolution>/);
  assert.match(requestAuth, /authGetUserCount \+= 1/);
  assert.doesNotMatch(requestAuth, /getSession\(/);
});

test('T11 permission map faz uma RPC agregada, nao um RPC por codigo', () => {
  assert.match(permissions, /current_user_permission_codes/);
  assert.match(permissions, /permissionRpcCount \+= 1/);
  assert.doesNotMatch(permissions, /permissionCodes\.map\(async \(code\) => \{\s*map\[code\] = await hasPermission/);
  assert.doesNotMatch(permissions, /rpc\('current_user_has_permission'/);
});

test('hasPermission do usuario atual consulta o mapa cacheado; outro usuario continua fail-closed via user_has_permission', () => {
  assert.match(permissions, /loadGrantedPermissionState/);
  assert.match(permissions, /user_has_permission/);
  assert.match(permissions, /if \(error\) return false/);
});

test('requireAnyPermission nao itera RPC por codigo', () => {
  assert.match(permissions, /export async function requireAnyPermission/);
  assert.match(permissions, /permissionCodes\.some\(\(code\) => state\.codes\.has\(code\)\)/);
});

test('T6 erro de RPC = fail-closed', () => {
  assert.match(permissions, /if \(error\) return \{ status: 'error' \}/);
  assert.match(permissions, /if \(state.status !== 'ok'\) return false/);
});

test('Minha Conta resolve landing uma vez via helper compartilhado', () => {
  assert.match(minhaContaLayout, /resolveAdministrativeLandingPage/);
});

test('canAccessAdministrativePanel do ator atual usa o mapa, nao 32 RPCs', () => {
  assert.match(panelAccess, /getCurrentPermissionMap\(\[\.\.\.ADMINISTRATIVE_PANEL_PERMISSION_CODES\]\)/);
});

test('migration do mapa agregado e segura', () => {
  assert.match(migration, /create or replace function public\.current_user_permission_codes\(\)/);
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = public, pg_temp/);
  assert.match(migration, /v_actor uuid := auth\.uid\(\)/);
  assert.match(migration, /revoke all on function public\.current_user_permission_codes\(\) from public, anon/);
  assert.match(migration, /grant execute on function public\.current_user_permission_codes\(\) to authenticated/);
  assert.doesNotMatch(migration, /20261008000000/);
  assert.match(migration, /nunca lista outro usuario/i);
});

test('owner recebe permissoes ativas; deny vence allow/role', () => {
  assert.match(migration, /ar\.code = 'owner'/);
  assert.match(migration, /uo\.effect = 'deny'/);
  assert.match(migration, /uo\.effect = 'allow'/);
});

test('T5/T12 mapa agregado nao enfraquece RLS nem troca de organizacao', () => {
  assert.doesNotMatch(migration, /disable row level security/i);
  assert.doesNotMatch(migration, /drop policy/i);
  assert.doesNotMatch(migration, /grant all on/i);
  assert.doesNotMatch(migration, /p_user_id/);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(permissions, /if \(error\) return \{ status: 'error' \}/);
});
