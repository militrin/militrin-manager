import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const migration = await readFile(
  new URL('../supabase/migrations/20260944000000_harden_financial_rpc_authorization.sql', import.meta.url),
  'utf8',
);
const registrationActions = await readFile(
  new URL('../src/app/inscricoes/actions.ts', import.meta.url),
  'utf8',
);
const publicActions = await readFile(
  new URL('../src/app/inscricao/actions.ts', import.meta.url),
  'utf8',
);
const storeActions = await readFile(
  new URL('../src/lib/store/actions.ts', import.meta.url),
  'utf8',
);
const pickupActions = await readFile(
  new URL('../src/app/retirada/actions.ts', import.meta.url),
  'utf8',
);
const rpcWrappers = await readFile(
  new URL('../src/lib/supabase/rpc.ts', import.meta.url),
  'utf8',
);

test('migration 44 fecha simuladores e helpers para clientes', () => {
  for (const signature of [
    'simulate_order_payment_paid(uuid, text)',
    'simulate_payment_paid(uuid, text)',
    'simulate_store_order_payment(uuid, text)',
    'confirm_order_payment_and_issue_tickets(uuid)',
    'confirm_order_item_and_issue_ticket(uuid)',
    'confirm_registration_payment(uuid)',
    'confirm_order_and_issue_ticket(uuid)',
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${signature.replace(/[()]/g, '\\$&')}\\s+from public, anon, authenticated, service_role`, 'i'),
      `${signature} deve ser revogada de clientes`,
    );
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${signature.replace(/[()]/g, '\\$&')}\\s+to service_role`, 'i'),
      `${signature} deve permanecer disponível ao backend`,
    );
  }
});

test('RPCs de cliente rejeitam auth.uid nulo e removem grant anon', () => {
  for (const name of [
    'start_order_payment_pix',
    'start_payment_pix',
    'get_participant_payment_details',
    'get_ticket_payment_operational_status',
    'start_store_order_payment_pix',
    'cancel_store_order',
    'cancel_registration_payment',
  ]) {
    const start = migration.indexOf(`function public.${name}(`);
    assert.notEqual(start, -1, `${name} deve ser definida na migration`);
    const body = migration.slice(start, migration.indexOf('$$;', start) + 3);
    assert.match(body, /v_actor uuid := auth\.uid\(\)/i);
    assert.match(body, /if v_actor is null then/i);
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${name}\\([\\s\\S]*?from public, anon, authenticated, service_role`, 'i'),
      `${name} deve revogar anon explicitamente`,
    );
  }
});

test('migration P0 nao altera default privileges globalmente', () => {
  assert.doesNotMatch(migration, /^\s*alter default privileges/gim);
});

test('aplicacao nao chama mais simulate_payment_paid diretamente', () => {
  assert.doesNotMatch(registrationActions, /\.rpc\(["']simulate_payment_paid["']/);
  assert.doesNotMatch(publicActions, /\.rpc\(["']simulate_payment_paid["']/);
  assert.match(registrationActions, /\.rpc\(["']admin_update_payment_status["']/);
});

test('Retirada continua usando a RPC nova apos a migration 44, com fallback so para function does not exist', () => {
  assert.match(pickupActions, /get_ticket_payment_operational_status/);
  assert.match(pickupActions, /isUndefinedDatabaseFunction/);
  assert.match(pickupActions, /\.select\("payment_status"\)/);
  assert.doesNotMatch(pickupActions, /get_participant_payment_details/);
});

test('simulacao local da loja autentica ownership antes de usar service role', () => {
  const gate = storeActions.indexOf('process.env.NODE_ENV !== "development"');
  const localOnly = storeActions.indexOf('!isLocalSupabase', gate);
  const auth = storeActions.indexOf('supabase.auth.getUser()', gate);
  const ownership = storeActions.indexOf('.eq("user_id", user.id)', auth);
  const admin = storeActions.indexOf('createServiceRoleSupabaseClient()', ownership);
  const simulation = storeActions.indexOf('admin.rpc("simulate_store_order_payment"', admin);
  assert.ok(
    gate >= 0
      && localOnly > gate
      && auth > localOnly
      && ownership > auth
      && admin > ownership
      && simulation > admin,
  );
});

const RESTRICTED_INTERNAL_RPCS = [
  'confirm_order_payment_and_issue_tickets',
  'confirm_order_item_and_issue_ticket',
  'confirm_registration_payment',
  'confirm_order_and_issue_ticket',
  'simulate_payment_paid',
  'simulate_order_payment_paid',
  'simulate_store_order_payment',
];

async function listTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listTsFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test('nenhum call site de aplicacao chama diretamente helpers internos de emissao da migration 44', async () => {
  assert.doesNotMatch(publicActions, /createPublicRegistrationAction/);
  assert.match(publicActions, /createPublicMultiOrderAction/);
  assert.doesNotMatch(publicActions, /\.rpc\(['"]create_registration['"]/);
  assert.doesNotMatch(rpcWrappers, /createRegistrationWithRpc|create_registration/);

  const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
  const rpcCall = /\.rpc\s*\(\s*['"]([^'"]+)['"]/g;
  const violations = [];

  for (const file of await listTsFiles(srcRoot)) {
    const source = await readFile(file, 'utf8');
    const rel = relative(srcRoot, file).replaceAll('\\', '/');
    for (const match of source.matchAll(rpcCall)) {
      const rpcName = match[1];
      if (!RESTRICTED_INTERNAL_RPCS.includes(rpcName)) continue;
      const isLocalStoreSim = rel === 'lib/store/actions.ts'
        && rpcName === 'simulate_store_order_payment'
        && source.includes('createServiceRoleSupabaseClient()')
        && /admin\.rpc\(["']simulate_store_order_payment["']/.test(source);
      if (isLocalStoreSim) continue;
      violations.push(`${rel} -> ${rpcName}`);
    }
  }

  assert.deepEqual(violations, []);
});
