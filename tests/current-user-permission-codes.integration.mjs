import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
  }));
}

const envText = await readFile(new URL('../.env.local', import.meta.url), 'utf8').catch(() => '');
const env = parseEnv(envText);
const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

function authedClient(accessToken) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function sessionForEmail(email) {
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const started = Date.now();
  const { data: linkData, error: linkError } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  console.info(JSON.stringify({
    src: 'auth-permissions-test',
    generateLinkMs: Date.now() - started,
    generateOk: !linkError,
    status: linkError?.status ?? null,
  }));
  if (linkError || !linkData?.properties?.hashed_token) return null;
  const { data: otpData, error: otpError } = await anon.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'email',
  });
  if (otpError || !otpData?.session?.access_token) return null;
  return { accessToken: otpData.session.access_token, userId: otpData.user?.id ?? null };
}

function isUnavailablePostgrest(error) {
  return Boolean(error) && (error.code === 'PGRST002' || /schema cache/i.test(error.message ?? ''));
}

test('T3 usuario sem sessao recebe mapa vazio', { skip: !url || !anonKey }, async (t) => {
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.rpc('current_user_permission_codes');
  if (isUnavailablePostgrest(error)) {
    t.skip('PostgREST schema cache unavailable');
    return;
  }
  if (error) {
    assert.match(String(error.code ?? error.message), /PGRST202|42501|PGRST301|permission|JWT/i);
    return;
  }
  assert.ok(Array.isArray(data));
  assert.equal(data.length, 0);
});

test('T3 service role sem jwt de usuario tambem nao concede mapa', { skip: !url || !serviceKey }, async (t) => {
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await service.rpc('current_user_permission_codes');
  if (isUnavailablePostgrest(error)) {
    t.skip('PostgREST schema cache unavailable');
    return;
  }
  assert.equal(error, null);
  assert.ok(Array.isArray(data));
  assert.equal(data.length, 0);
});

test('T12 RLS continua protegendo tickets sem sessao', { skip: !url || !anonKey }, async (t) => {
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.from('tickets').select('id').limit(5);
  if (isUnavailablePostgrest(error)) {
    t.skip('PostgREST schema cache unavailable');
    return;
  }
  assert.equal(error, null);
  assert.equal((data ?? []).length, 0);
});

test('T1/T4 owner autenticado recebe permissoes reais e codigo inexistente fica de fora', {
  skip: !url || !serviceKey || !anonKey,
  timeout: 180000,
}, async (t) => {
  const session = await sessionForEmail('h.dogui@gmail.com');
  if (!session) {
    t.skip('owner session unavailable');
    return;
  }
  const authed = authedClient(session.accessToken);
  const rpcStarted = Date.now();
  const { data, error } = await authed.rpc('current_user_permission_codes');
  console.info(JSON.stringify({
    src: 'auth-permissions-test',
    permissionMapMs: Date.now() - rpcStarted,
    n: Array.isArray(data) ? data.length : null,
  }));
  if (isUnavailablePostgrest(error)) {
    t.skip('PostgREST schema cache unavailable');
    return;
  }
  assert.equal(error, null);
  assert.ok(Array.isArray(data));
  assert.ok(data.includes('participants.view'), 'T1 owner deve receber permissao administrativa real');
  assert.ok(data.includes('orders.view'));
  assert.equal(data.includes('this.permission.does.not.exist'), false, 'T4 permissao inexistente nao entra no mapa');
});

test('T2 participante comum nao recebe admin', {
  skip: !url || !serviceKey || !anonKey,
  timeout: 180000,
}, async (t) => {
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const [{ data: admins, error: adminError }, { data: participants, error: participantError }] = await Promise.all([
    service.from('admin_users').select('user_id').eq('is_active', true),
    service.from('participants').select('user_id').not('user_id', 'is', null).limit(80),
  ]);
  if (isUnavailablePostgrest(adminError) || isUnavailablePostgrest(participantError)) {
    t.skip('PostgREST schema cache unavailable');
    return;
  }
  const adminIds = new Set((admins ?? []).map((row) => String(row.user_id)));
  const candidateId = (participants ?? []).map((row) => String(row.user_id)).find((id) => id && !adminIds.has(id));
  if (!candidateId) {
    t.skip('no non-admin participant');
    return;
  }
  const { data: userData, error: userError } = await service.auth.admin.getUserById(candidateId);
  const email = userData?.user?.email ?? null;
  if (userError || !email) {
    t.skip('participant email unavailable');
    return;
  }
  const session = await sessionForEmail(email);
  if (!session) {
    t.skip('participant session unavailable');
    return;
  }
  const authed = authedClient(session.accessToken);
  const { data, error } = await authed.rpc('current_user_permission_codes');
  if (isUnavailablePostgrest(error)) {
    t.skip('PostgREST schema cache unavailable');
    return;
  }
  assert.equal(error, null);
  assert.ok(Array.isArray(data));
  assert.equal(data.length, 0, 'T2 participante nao deve receber codigo administrativo');
});

test('T5 organizacao errada nao concede dados via RLS', {
  skip: !url || !serviceKey || !anonKey,
  timeout: 180000,
}, async (t) => {
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { count: allTickets, error: countError } = await service.from('tickets').select('id', { count: 'exact', head: true });
  if (isUnavailablePostgrest(countError)) {
    t.skip('PostgREST schema cache unavailable');
    return;
  }
  const [{ data: admins }, { data: participants }] = await Promise.all([
    service.from('admin_users').select('user_id').eq('is_active', true),
    service.from('participants').select('user_id').not('user_id', 'is', null).limit(80),
  ]);
  const adminIds = new Set((admins ?? []).map((row) => String(row.user_id)));
  const candidateId = (participants ?? []).map((row) => String(row.user_id)).find((id) => id && !adminIds.has(id));
  if (!candidateId) {
    t.skip('no non-admin participant');
    return;
  }
  const { data: userData } = await service.auth.admin.getUserById(candidateId);
  const email = userData?.user?.email ?? null;
  if (!email) {
    t.skip('participant email unavailable');
    return;
  }
  const session = await sessionForEmail(email);
  if (!session) {
    t.skip('participant session unavailable');
    return;
  }
  const authed = authedClient(session.accessToken);
  const { data, error } = await authed.from('tickets').select('id').limit(50);
  if (isUnavailablePostgrest(error)) {
    t.skip('PostgREST schema cache unavailable');
    return;
  }
  assert.equal(error, null);
  const visible = data ?? [];
  assert.ok((allTickets ?? 0) > visible.length, 'T5 participante nao deve ver o universo de tickets');
});
