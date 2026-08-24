import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `marcador de fim nao encontrado: ${endMarker}`);
  return source.slice(start, end);
}

const migration = await read('supabase/migrations/20260877000000_materialize_org_membership_on_team_upsert.sql');

test('migration materializa organization_members para admins promovidos antes do deploy', () => {
  const backfill = slice(migration, 'insert into public.organization_members (', 'CREATE OR REPLACE FUNCTION');
  assert.match(backfill, /from public\.admin_users au/);
  assert.match(backfill, /public\.resolve_default_registration_organization\(\)/);
  assert.match(backfill, /where default_org\.organization_id is not null/);
  assert.match(backfill, /not exists \([\s\S]*om\.user_id = au\.user_id/);
  assert.match(backfill, /au\.is_active/);
});

test('upsert canonico materializa e sincroniza o vinculo da organizacao', () => {
  const fn = slice(migration, 'CREATE OR REPLACE FUNCTION "public"."upsert_admin_user_access"', 'ALTER FUNCTION');
  assert.match(fn, /v_default_organization_id := public\.resolve_default_registration_organization\(\)/);
  assert.match(fn, /insert into public\.organization_members \(organization_id, user_id, is_owner, is_active\)/);
  assert.match(fn, /values \(v_default_organization_id, p_target_user_id, false, coalesce\(p_is_active, true\)\)/);
  assert.match(fn, /on conflict \(organization_id, user_id\) do update set[\s\S]*is_active = excluded\.is_active/);
});

test('dashboard sem organizacao retorna estado vazio e a pagina explica o vinculo ausente', async () => {
  const [loader, page] = await Promise.all([
    read('src/lib/dashboard/admin-dashboard-data.ts'),
    read('src/app/painel/page.tsx'),
  ]);
  assert.doesNotMatch(loader, /if \(!organization\?\.id\) throw/);
  assert.match(loader, /return \{ organization: null, events: \[\], selectedEvent: null, metrics: new Map/);
  assert.match(page, /!data\.organization \? <AdminEmptyState title="Nenhuma organização vinculada à sua conta"/);
});
