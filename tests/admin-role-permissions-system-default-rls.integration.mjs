// Regressao da correcao de RLS em public.admin_role_permissions_system_default
// (supabase/migrations/20260899000000_admin_role_permissions_system_default_rls.sql).
// Roda contra o Supabase local (`supabase start`), no mesmo padrao dos demais
// *.integration.mjs deste projeto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

async function environment() {
  const text = await readFile(new URL('../.env.local', import.meta.url), 'utf8').catch(() => '');
  const local = Object.fromEntries(text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
  }));
  return {
    url: 'http://127.0.0.1:54321',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
    ...local,
  };
}

async function buildFixture() {
  const env = await environment();
  const service = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }
  async function clientFor(email, password) {
    const client = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`login ${email}: ${signIn.error.message}`);
    return client;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';
  const org = await must(service.from('organizations').insert({ name: 'RLS Snapshot Test', slug: `rls-snap-${suffix}` }).select('id').single(), 'org');

  const ownerEmail = `rls-snap-owner-${suffix}@qa.local`;
  const plainEmail = `rls-snap-plain-${suffix}@qa.local`;
  const ownerCreated = await must(service.auth.admin.createUser({ email: ownerEmail, password, email_confirm: true }), 'create owner');
  const plainCreated = await must(service.auth.admin.createUser({ email: plainEmail, password, email_confirm: true }), 'create plain user');
  await must(service.from('organization_members').insert({ organization_id: org.id, user_id: ownerCreated.user.id, is_owner: true, is_active: true }), 'owner org member');
  await must(service.from('organization_members').insert({ organization_id: org.id, user_id: plainCreated.user.id, is_owner: false, is_active: true }), 'plain org member');

  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  await must(service.from('admin_users').insert({ user_id: ownerCreated.user.id, role_id: ownerRole.id, is_active: true }), 'admin_users owner');

  const viewerRole = await must(service.from('admin_roles').select('id').eq('code', 'viewer').maybeSingle(), 'viewer role lookup');
  if (viewerRole) {
    await must(service.from('admin_users').insert({ user_id: plainCreated.user.id, role_id: viewerRole.id, is_active: true }), 'admin_users viewer');
  }

  const financeRole = await must(service.from('admin_roles').select('id').eq('code', 'finance').maybeSingle(), 'finance role lookup');
  const operationalRole = await must(service.from('admin_roles').select('id').eq('code', 'operational').maybeSingle(), 'operational role lookup');
  const marketingRole = await must(service.from('admin_roles').select('id').eq('code', 'marketing').maybeSingle(), 'marketing role lookup');

  const ownerClient = await clientFor(ownerEmail, password);
  const plainClient = await clientFor(plainEmail, password);

  return { service, anon, ownerClient, plainClient, org, must, financeRole, operationalRole, marketingRole, viewerRole };
}

const fx = await buildFixture();

test('anon nao consegue mais SELECT em admin_role_permissions_system_default', async () => {
  const result = await fx.anon.from('admin_role_permissions_system_default').select('role_id').limit(1);
  assert.ok(result.error, 'anon deveria receber erro de permissao (RLS + REVOKE), nunca conseguir ler');
});

test('usuario autenticado comum nao consegue ler a matriz diretamente (nenhuma policy existe -- so RPC)', async () => {
  const result = await fx.plainClient.from('admin_role_permissions_system_default').select('role_id').limit(1);
  assert.ok(result.error, 'authenticated sem policy dedicada deveria ser bloqueado tambem');
});

test('service_role continua com acesso direto (usado por tooling/migrations, sempre ignora RLS)', async () => {
  const result = await fx.service.from('admin_role_permissions_system_default').select('role_id').limit(1);
  assert.equal(result.error, null, result.error?.message);
});

test('Owner continua conseguindo listar permissoes de uma funcao via RPC (list_admin_role_permissions)', async () => {
  if (!fx.financeRole) return; // seed local pode nao ter rodado todas as migrations de feature -- nao é o alvo desta regressao
  const result = await fx.ownerClient.rpc('list_admin_role_permissions', { p_role_id: fx.financeRole.id });
  assert.equal(result.error, null, result.error?.message);
  assert.ok(Array.isArray(result.data) && result.data.length > 0, 'lista de permissoes nao deveria vir vazia');
});

test('Owner continua conseguindo restaurar o padrao do sistema via RPC (restore_admin_role_permissions_default)', async () => {
  if (!fx.operationalRole) return;
  const before = await fx.must(fx.service.from('admin_role_permissions').select('permission_id').eq('role_id', fx.operationalRole.id), 'permissoes atuais operational');
  const result = await fx.must(fx.ownerClient.rpc('restore_admin_role_permissions_default', {
    p_role_id: fx.operationalRole.id, p_reason: 'Regressao Fase RLS admin_role_permissions_system_default',
  }), 'restore default operational');
  assert.equal(result.success, true);
  const after = await fx.must(fx.service.from('admin_role_permissions').select('permission_id').eq('role_id', fx.operationalRole.id), 'permissoes apos restore operational');
  // Customizacoes atuais == defaults (confirmado pela auditoria) -- restaurar
  // nao deveria mudar a contagem de permissoes da funcao Operacional.
  assert.equal(after.length, before.length, 'restaurar o padrao do sistema nao deveria alterar a quantidade de permissoes de Operacional (customizacao == default)');
});

test('Owner continua conseguindo editar permissoes de uma funcao via upsert_admin_role_permissions (Marketing)', async () => {
  if (!fx.marketingRole) return;
  const current = await fx.must(fx.ownerClient.rpc('list_admin_role_permissions', { p_role_id: fx.marketingRole.id }), 'list marketing perms');
  const codes = current.filter((row) => row.has_permission).map((row) => row.code);
  const result = await fx.must(fx.ownerClient.rpc('upsert_admin_role_permissions', {
    p_role_id: fx.marketingRole.id, p_permission_codes: codes, p_reason: 'Regressao Fase RLS -- reafirma o mesmo conjunto',
  }), 'upsert marketing perms (no-op)');
  assert.equal(result.success, true);
  assert.deepEqual(result.added_permissions, []);
  assert.deepEqual(result.removed_permissions, []);
});
