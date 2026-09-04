// Gate local da migration 49 contra Postgres real.
// Nao herda .env.local (producao). Nao envia e-mail. Nao muta remoto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

const url = 'http://127.0.0.1:54321';
const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const serviceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const password = 'SenhaForte!123';

function generateValidCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  function checkDigit(nums) {
    let sum = 0;
    let weight = nums.length + 1;
    for (const n of nums) { sum += n * weight; weight -= 1; }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  }
  const d1 = checkDigit(base);
  const d2 = checkDigit([...base, d1]);
  return [...base, d1, d2].join('');
}

function generateValidCpfStartingWithZero() {
  for (let i = 0; i < 2000; i += 1) {
    const cpf = generateValidCpf();
    if (cpf.startsWith('0')) return cpf;
  }
  throw new Error('nao gerou CPF valido com zero inicial');
}

function psql(sql) {
  return execFileSync('docker', ['exec', 'supabase_db_militrin-manager', 'psql', '-U', 'postgres', '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  }).trim();
}

async function must(promise, label) {
  const result = await promise;
  if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.data;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

execFileSync('docker', ['exec', 'supabase_db_militrin-manager', 'psql', '-U', 'postgres', '-c', "NOTIFY pgrst, 'reload schema';"], { encoding: 'utf8' });

const service = createClient(url, serviceKey, options);
const anon = createClient(url, anonKey, options);

async function clientFor(email) {
  const client = createClient(url, anonKey, options);
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`login ${email}: ${signIn.error.message}`);
  return client;
}

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const adminEmail = `m49-admin-${suffix}@qa.local`;
const createdAdmin = await must(service.auth.admin.createUser({ email: adminEmail, password, email_confirm: true }), 'admin user');
const adminUserId = createdAdmin.user.id;
const org = await must(service.from('organizations').insert({
  name: 'M49 Pilot Org', slug: `m49-pilot-${suffix}`, status: 'active',
}).select('id').single(), 'org');
const event = await must(service.from('events').insert({
  organization_id: org.id, name: 'Evento M49 Pilot', year: 2026, slug: `m49-evt-${suffix}`,
  is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
}).select('id').single(), 'event');
const category = await must(service.from('ticket_categories').insert({
  event_id: event.id, name: 'Geral', slug: `m49-geral-${suffix}`, is_active: true,
}).select('id').single(), 'category');
const regBatch = await must(service.from('registration_batches').insert({
  event_id: event.id, name: 'Lote 1', sequence_number: 1, male_price: 100, female_price: 100,
  max_confirmed_registrations: 200, is_active: true,
}).select('id').single(), 'reg batch');
await must(service.from('registration_batch_prices').insert({
  batch_id: regBatch.id, ticket_category_id: category.id, male_price: 100, female_price: 100,
}), 'price');
const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
await must(service.from('admin_users').insert({ user_id: adminUserId, role_id: ownerRole.id, is_active: true }), 'admin_users');
await must(service.from('organization_members').insert({
  organization_id: org.id, user_id: adminUserId, role_id: ownerRole.id, is_owner: true, is_active: true,
}), 'membership');
const admin = await clientFor(adminEmail);

const commonEmail = `m49-common-${suffix}@qa.local`;
await must(service.auth.admin.createUser({ email: commonEmail, password, email_confirm: true }), 'common user');
const common = await clientFor(commonEmail);

async function createImportBatch(fileHash, fileName, extra = {}) {
  return must(service.from('import_batches').insert({
    import_type: 'current_event_registrations',
    event_id: event.id,
    organization_id: org.id,
    imported_by: adminUserId,
    total_rows: extra.total_rows ?? 1,
    status: extra.status ?? 'processing',
    file_name: fileName,
    source_file_hash: fileHash,
    payment_mode_original: extra.payment_mode_original ?? 'confirm_all',
  }).select('id,source_file_hash,status').single(), `batch ${fileName}`);
}

async function createRow(batchId, rowNumber, normalized, extra = {}) {
  return must(service.from('import_batch_rows').insert({
    import_batch_id: batchId,
    row_number: rowNumber,
    status: extra.status ?? 'ready',
    resolution: extra.resolution ?? 'create_new',
    normalized_data: normalized,
    raw_data: extra.raw_data ?? {},
    data_issues: extra.data_issues ?? [],
    identity_match_details: extra.identity_match_details ?? {},
    row_fingerprint: extra.row_fingerprint ?? null,
    occurrence_index: extra.occurrence_index ?? 1,
    source_file_hash: extra.source_file_hash ?? null,
    external_purchase_key: extra.external_purchase_key ?? null,
    intended_owner_contact_id: extra.intended_owner_contact_id ?? null,
    possible_reimport_of_row_id: extra.possible_reimport_of_row_id ?? null,
    cpf_excel_candidate: extra.cpf_excel_candidate ?? null,
    cpf_cell_kind: extra.cpf_cell_kind ?? null,
    error_message: extra.error_message ?? null,
  }).select('*').single(), `row ${rowNumber}`);
}

function personNormalized(person) {
  return {
    full_name: person.fullName,
    cpf: person.cpf ?? '',
    cpf_input: person.cpfInput ?? person.cpf ?? '',
    cpf_raw: person.cpfRaw ?? person.cpfInput ?? person.cpf ?? '',
    email: person.email,
    birth_date: person.birthDate ?? '1990-05-10',
    gender: person.gender ?? null,
    phone: person.phone ?? '11999990001',
    city: person.city ?? 'Itapiranga',
    shirt_type: person.shirtType ?? 'Camiseta',
    shirt_size: person.shirtSize ?? 'M',
    resolved_batch_id: regBatch.id,
    resolved_category_id: category.id,
    payment_method: 'pix',
  };
}

async function importLine(batchId, rowId, person, extraRpc = {}) {
  const result = await admin.rpc('import_current_event_contact_first', {
    p_import_batch_id: batchId,
    p_import_batch_row_id: rowId,
    p_expected_registration_contact_id: extraRpc.expectedContactId ?? null,
    p_full_name: person.fullName,
    p_cpf: person.cpf ?? null,
    p_birth_date: person.birthDate ?? '1990-05-10',
    p_gender: person.gender ?? null,
    p_phone: person.phone ?? '11999990001',
    p_email: person.email,
    p_city: person.city ?? 'Itapiranga',
    p_shirt_type: person.shirtType ?? 'Camiseta',
    p_shirt_size: person.shirtSize ?? 'M',
    p_registration_batch_id: regBatch.id,
    p_ticket_category_id: category.id,
    p_payment_method: 'pix',
    p_import_issues: extraRpc.issues ?? [],
    p_assign_holder: extraRpc.assignHolder ?? true,
    p_intended_owner_contact_id: extraRpc.intendedOwnerContactId ?? null,
  });
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}

async function finalizeItem(orderItemId) {
  const result = await admin.rpc('finalize_imported_ticket_after_issue_resolution', {
    p_order_item_id: orderItemId,
    p_resolved_fields: [],
    p_force_confirm: false,
  });
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}

async function countForContact(contactId) {
  const items = await must(service.from('order_items').select('id,order_id,ownership_status,shirt_type,shirt_size,registration_contact_id,intended_owner_contact_id').eq('registration_contact_id', contactId).eq('event_id', event.id), 'items');
  const orderIds = [...new Set(items.map((row) => row.order_id))];
  const payments = orderIds.length
    ? await must(service.from('payments').select('id,order_id,payment_status').in('order_id', orderIds), 'payments')
    : [];
  const tickets = items.length
    ? await must(service.from('tickets').select('id,order_item_id,owner_user_id,intended_owner_contact_id,token,status').in('order_item_id', items.map((row) => row.id)), 'tickets')
    : [];
  return { items, payments, tickets, orders: orderIds };
}

test('RPC signatures: so a assinatura nova; sem overload 17-arg ou 3-arg', () => {
  const importOverloads = psql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='import_current_event_contact_first'");
  const reviewOverloads = psql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='resolve_import_batch_row_review'");
  const importArgs = psql("select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='import_current_event_contact_first'");
  const reviewArgs = psql("select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='resolve_import_batch_row_review'");
  assert.equal(importOverloads, '1');
  assert.equal(reviewOverloads, '1');
  assert.match(importArgs, /p_intended_owner_contact_id uuid$/);
  assert.match(reviewArgs, /p_payload jsonb$/);
  assert.doesNotMatch(importArgs, /\n/);
});

test('grants reais: materialize nao executavel por anon/authenticated; RPCs admin bloqueadas por RBAC', async () => {
  const materializeAuth = psql("select has_function_privilege('authenticated', 'public.materialize_intended_ticket_owners_for_contact(uuid,uuid)', 'EXECUTE')");
  const materializeAnon = psql("select has_function_privilege('anon', 'public.materialize_intended_ticket_owners_for_contact(uuid,uuid)', 'EXECUTE')");
  const materializeService = psql("select has_function_privilege('service_role', 'public.materialize_intended_ticket_owners_for_contact(uuid,uuid)', 'EXECUTE')");
  assert.equal(materializeAuth, 'f');
  assert.equal(materializeAnon, 'f');
  assert.equal(materializeService, 't');

  const dummy = '00000000-0000-0000-0000-000000000001';
  const anonMaterialize = await anon.rpc('materialize_intended_ticket_owners_for_contact', { p_contact_id: dummy, p_user_id: dummy });
  assert.ok(anonMaterialize.error, 'anon nao pode materializar ownership');
  const commonMaterialize = await common.rpc('materialize_intended_ticket_owners_for_contact', { p_contact_id: dummy, p_user_id: dummy });
  assert.ok(commonMaterialize.error, 'authenticated comum nao pode materializar ownership');

  const anonAssign = await anon.rpc('assign_imported_ticket_owner_contact', { p_order_item_ids: [dummy], p_owner_registration_contact_id: dummy });
  assert.ok(anonAssign.error);
  const commonAssign = await common.rpc('assign_imported_ticket_owner_contact', { p_order_item_ids: [dummy], p_owner_registration_contact_id: dummy });
  assert.ok(commonAssign.error);
  const commonImport = await common.rpc('import_current_event_contact_first', {
    p_import_batch_id: dummy, p_import_batch_row_id: dummy, p_expected_registration_contact_id: null,
    p_full_name: 'X', p_cpf: null, p_birth_date: null, p_gender: null, p_phone: null, p_email: null, p_city: null,
    p_shirt_type: null, p_shirt_size: null, p_registration_batch_id: null, p_ticket_category_id: null,
  });
  assert.ok(commonImport.error);
  const commonReview = await common.rpc('resolve_import_batch_row_review', { p_row_id: dummy, p_decision: 'assign_owner_contact' });
  assert.ok(commonReview.error);
});

test('intended_owner permanece nullable apos replay; sem backfill obrigatorio', () => {
  const nullable = psql(`
    select is_nullable
    from information_schema.columns
    where table_schema='public' and table_name='tickets' and column_name='intended_owner_contact_id'
  `);
  const itemNullable = psql(`
    select is_nullable
    from information_schema.columns
    where table_schema='public' and table_name='order_items' and column_name='intended_owner_contact_id'
  `);
  assert.equal(nullable, 'YES');
  assert.equal(itemNullable, 'YES');
});

const douglasCpf = generateValidCpf();
const douglas = {
  fullName: 'Douglas Teste',
  cpf: douglasCpf,
  email: `douglas-${suffix}@example.invalid`,
};
const fileABytes = `douglas-piloto-${suffix}-file-a`;
const fileAHash = sha256(fileABytes);
const fingerprintA = sha256('douglas-camiseta-m');
const fingerprintB = sha256('douglas-identical-line');

test('cenarios A-D: 3 compras da mesma Pessoa, linhas identicas, mesmo arquivo, retry idempotente', async () => {
  const batch = await createImportBatch(fileAHash, 'piloto-douglas.xlsx', { total_rows: 4, payment_mode_original: 'confirm_all' });
  const row1 = await createRow(batch.id, 1, personNormalized({ ...douglas, shirtType: 'Camiseta', shirtSize: 'M' }), {
    row_fingerprint: fingerprintA, occurrence_index: 1, source_file_hash: fileAHash,
  });
  const row2 = await createRow(batch.id, 2, personNormalized({ ...douglas, shirtType: 'Camiseta', shirtSize: 'GG' }), {
    row_fingerprint: sha256('douglas-camiseta-gg'), occurrence_index: 1, source_file_hash: fileAHash,
  });
  const row3 = await createRow(batch.id, 3, personNormalized({ ...douglas, shirtType: 'Babylook', shirtSize: 'P', gender: null }), {
    row_fingerprint: sha256('douglas-babylook-p'), occurrence_index: 1, source_file_hash: fileAHash,
  });
  const row4 = await createRow(batch.id, 4, personNormalized({ ...douglas, shirtType: 'Camiseta', shirtSize: 'M' }), {
    row_fingerprint: fingerprintB, occurrence_index: 1, source_file_hash: fileAHash,
  });
  const row5 = await createRow(batch.id, 5, personNormalized({ ...douglas, shirtType: 'Camiseta', shirtSize: 'M' }), {
    row_fingerprint: fingerprintB, occurrence_index: 2, source_file_hash: fileAHash,
  });

  const first = await importLine(batch.id, row1.id, { ...douglas, shirtType: 'Camiseta', shirtSize: 'M' });
  const second = await importLine(batch.id, row2.id, { ...douglas, shirtType: 'Camiseta', shirtSize: 'GG' });
  const third = await importLine(batch.id, row3.id, { ...douglas, shirtType: 'Babylook', shirtSize: 'P', gender: null });
  const ident1 = await importLine(batch.id, row4.id, { ...douglas, shirtType: 'Camiseta', shirtSize: 'M' });
  const ident2 = await importLine(batch.id, row5.id, { ...douglas, shirtType: 'Camiseta', shirtSize: 'M' });

  assert.equal(first.registration_contact_id, second.registration_contact_id);
  assert.equal(second.registration_contact_id, third.registration_contact_id);
  assert.equal(first.holder_assigned, true);
  assert.equal(second.holder_assigned, false);
  assert.equal(third.holder_assigned, false);
  assert.notEqual(ident1.order_item_id, ident2.order_item_id);

  const retry = await importLine(batch.id, row1.id, { ...douglas, shirtType: 'Camiseta', shirtSize: 'M' });
  assert.equal(retry.order_item_id, first.order_item_id);
  assert.equal(retry.order_id, first.order_id);

  for (const imported of [first, second, third, ident1, ident2]) {
    const finalized = await finalizeItem(imported.order_item_id);
    assert.equal(finalized.finalization, 'paid_and_ticket_issued', JSON.stringify(finalized));
    assert.ok(finalized.ticket_id);
  }

  const contactId = first.registration_contact_id;
  const counted = await countForContact(contactId);
  assert.equal(counted.items.length, 5);
  assert.equal(counted.orders.length, 5);
  assert.equal(counted.payments.length, 5);
  assert.equal(counted.tickets.length, 5);
  assert.equal(counted.items.filter((item) => item.ownership_status === 'assigned').length, 1);
  assert.equal(counted.items.filter((item) => item.registration_contact_id === contactId).length, 5);
  assert.ok(counted.items.some((item) => item.shirt_type === 'Camiseta' && item.shirt_size === 'M'));
  assert.ok(counted.items.some((item) => item.shirt_type === 'Camiseta' && item.shirt_size === 'GG'));
  assert.ok(counted.items.some((item) => item.shirt_type === 'Babylook' && item.shirt_size === 'P'));
  const contact = await must(service.from('registration_contacts').select('id,gender,cpf').eq('id', contactId).single(), 'douglas contact');
  assert.equal(contact.gender, null);
  assert.equal(contact.cpf, douglasCpf);

  const persistedRows = await must(service.from('import_batch_rows').select('id,row_fingerprint,occurrence_index,source_file_hash,order_item_id').eq('import_batch_id', batch.id).in('id', [row4.id, row5.id]), 'identical rows');
  const occ = persistedRows.map((row) => row.occurrence_index).sort();
  assert.deepEqual(occ, [1, 2]);
  assert.equal(persistedRows[0].row_fingerprint, persistedRows[1].row_fingerprint);
  assert.equal(persistedRows[0].source_file_hash, fileAHash);
  assert.notEqual(persistedRows[0].order_item_id, persistedRows[1].order_item_id);

  const previousSameFile = await must(service.from('import_batches').select('id,file_name,status,imported_rows,total_rows').eq('organization_id', org.id).eq('event_id', event.id).eq('source_file_hash', fileAHash).in('status', ['completed', 'ready_for_review', 'processing']).limit(1), 'same file');
  assert.equal(previousSameFile.length, 1);
  assert.equal(previousSameFile[0].id, batch.id);

  const audit = await must(service.from('audit_logs').select('action,details').eq('entity_type', 'registration_contacts').eq('entity_id', contactId), 'douglas audit');
  assert.ok(audit.some((entry) => entry.action === 'import_person_created'));
  assert.ok(audit.some((entry) => entry.details?.additional_purchase === true));

  globalThis.__m49 = { douglasContactId: contactId, douglasBatchId: batch.id, douglasOrderCount: counted.orders.length, fileAHash, firstRowId: row1.id };
});

test('cenario E: mesmo conteudo em outro arquivo gera revisao; nova compra vs duplicacao tecnica', async () => {
  const { douglasContactId, douglasOrderCount, fileAHash, firstRowId } = globalThis.__m49;
  const fileBHash = sha256(`douglas-piloto-${suffix}-file-b`);
  const batch = await createImportBatch(fileBHash, 'piloto-douglas-reimport.xlsx', { total_rows: 2, status: 'ready_for_review' });
  const newPurchaseRow = await createRow(batch.id, 1, personNormalized({ ...douglas, shirtType: 'Camiseta', shirtSize: 'M' }), {
    status: 'review_required', resolution: 'pending',
    row_fingerprint: fingerprintA, occurrence_index: 1, source_file_hash: fileBHash,
    possible_reimport_of_row_id: firstRowId,
    identity_match_details: { reason: 'possible_reimport', previous_import_batch_row_id: firstRowId },
    error_message: 'Possivel compra ja importada em outro arquivo.',
  });
  const dupRow = await createRow(batch.id, 2, personNormalized({ ...douglas, shirtType: 'Camiseta', shirtSize: 'M' }), {
    status: 'review_required', resolution: 'pending',
    row_fingerprint: fingerprintA, occurrence_index: 2, source_file_hash: fileBHash,
    possible_reimport_of_row_id: firstRowId,
    identity_match_details: { reason: 'possible_reimport', previous_import_batch_row_id: firstRowId },
  });

  const confirmNew = await admin.rpc('resolve_import_batch_row_review', {
    p_row_id: newPurchaseRow.id, p_decision: 'confirm_new_purchase',
  });
  assert.equal(confirmNew.error, null, confirmNew.error?.message);
  const ignoreDup = await admin.rpc('resolve_import_batch_row_review', {
    p_row_id: dupRow.id, p_decision: 'ignore_technical_duplicate',
  });
  assert.equal(ignoreDup.error, null, ignoreDup.error?.message);

  const confirmed = await must(service.from('import_batch_rows').select('status,resolution,review_decision').eq('id', newPurchaseRow.id).single(), 'confirmed row');
  assert.equal(confirmed.status, 'ready');
  assert.equal(confirmed.review_decision, 'confirm_new_purchase');
  const ignored = await must(service.from('import_batch_rows').select('status,resolution,review_decision,order_item_id').eq('id', dupRow.id).single(), 'ignored row');
  assert.equal(ignored.status, 'skipped');
  assert.equal(ignored.review_decision, 'ignore_technical_duplicate');
  assert.equal(ignored.order_item_id, null);

  const materialized = await importLine(batch.id, newPurchaseRow.id, { ...douglas, shirtType: 'Camiseta', shirtSize: 'M' }, { expectedContactId: douglasContactId });
  await finalizeItem(materialized.order_item_id);
  const counted = await countForContact(douglasContactId);
  assert.equal(counted.orders.length, douglasOrderCount + 1);
  assert.equal(fileAHash !== fileBHash, true);

  const audits = await must(service.from('audit_logs').select('action').in('action', ['import_new_purchase_confirmed', 'import_technical_duplicate_ignored']), 'reimport audits');
  assert.ok(audits.some((entry) => entry.action === 'import_new_purchase_confirmed'));
  assert.ok(audits.some((entry) => entry.action === 'import_technical_duplicate_ignored'));
});

const familyEmail = `familia.teste.${suffix}@example.invalid`;
const joaoCpf = generateValidCpf();
const mariaCpf = generateValidCpf();
const pedroCpf = generateValidCpf();

test('cenarios F+12+13+14: e-mail compartilhado, Maria como conta, claim e intent pos-claim nao rouba ownership', async () => {
  const fileHash = sha256(`familia-${suffix}`);
  const batch = await createImportBatch(fileHash, 'piloto-familia.xlsx', { total_rows: 3, payment_mode_original: 'confirm_all' });
  const people = [
    { fullName: 'Joao Teste', cpf: joaoCpf, email: familyEmail, shirtType: 'Camiseta', shirtSize: 'M' },
    { fullName: 'Maria Teste', cpf: mariaCpf, email: familyEmail, shirtType: 'Babylook', shirtSize: 'P' },
    { fullName: 'Pedro Teste', cpf: pedroCpf, email: familyEmail, shirtType: 'Camiseta', shirtSize: 'G' },
  ];
  const rows = [];
  const imported = [];
  for (const [index, person] of people.entries()) {
    const row = await createRow(batch.id, index + 1, personNormalized(person), {
      identity_match_details: { account_review: 'shared_email', reason: 'shared_email_account_review' },
      source_file_hash: fileHash,
      row_fingerprint: sha256(`${person.fullName}-${person.cpf}`),
      occurrence_index: 1,
    });
    rows.push(row);
    imported.push(await importLine(batch.id, row.id, person));
  }
  assert.equal(new Set(imported.map((row) => row.registration_contact_id)).size, 3);
  for (const row of imported) await finalizeItem(row.order_item_id);

  const contacts = await must(service.from('registration_contacts').select('id,full_name,cpf,email,user_id').eq('organization_id', org.id).in('cpf', [joaoCpf, mariaCpf, pedroCpf]), 'family contacts');
  assert.equal(contacts.length, 3);
  const maria = contacts.find((row) => row.cpf === mariaCpf);
  const joao = contacts.find((row) => row.cpf === joaoCpf);
  const pedro = contacts.find((row) => row.cpf === pedroCpf);
  assert.equal(maria.user_id, null);

  const beforeAssign = await admin.rpc('check_registration_contact_account_invite_eligibility', { p_registration_contact_id: maria.id });
  assert.equal(beforeAssign.error, null, beforeAssign.error?.message);
  const beforeRow = Array.isArray(beforeAssign.data) ? beforeAssign.data[0] : beforeAssign.data;
  assert.equal(beforeRow.eligible, false);
  assert.equal(beforeRow.reason_code, 'email_conflict');

  const assigned = await admin.rpc('resolve_import_batch_row_review', {
    p_row_id: rows[1].id,
    p_decision: 'assign_owner_contact',
    p_registration_contact_id: maria.id,
  });
  assert.equal(assigned.error, null, assigned.error?.message);

  const ticketsBeforeClaim = await must(service.from('tickets').select('id,owner_user_id,intended_owner_contact_id,order_item_id').in('order_item_id', imported.map((row) => row.order_item_id)), 'tickets before claim');
  assert.equal(ticketsBeforeClaim.length, 3);
  assert.ok(ticketsBeforeClaim.every((ticket) => ticket.intended_owner_contact_id === maria.id));
  assert.ok(ticketsBeforeClaim.every((ticket) => ticket.owner_user_id == null));

  const switched = await admin.rpc('resolve_import_batch_row_review', {
    p_row_id: rows[0].id,
    p_decision: 'assign_owner_contact',
    p_registration_contact_id: joao.id,
  });
  assert.equal(switched.error, null, switched.error?.message);
  const afterSwitch = await must(service.from('tickets').select('owner_user_id,intended_owner_contact_id').in('order_item_id', imported.map((row) => row.order_item_id)), 'tickets switched');
  assert.ok(afterSwitch.every((ticket) => ticket.intended_owner_contact_id === joao.id));
  assert.ok(afterSwitch.every((ticket) => ticket.owner_user_id == null));

  const restored = await admin.rpc('resolve_import_batch_row_review', {
    p_row_id: rows[1].id,
    p_decision: 'assign_owner_contact',
    p_registration_contact_id: maria.id,
  });
  assert.equal(restored.error, null, restored.error?.message);

  const eligibility = await admin.rpc('check_registration_contact_account_invite_eligibility', { p_registration_contact_id: maria.id });
  assert.equal(eligibility.error, null, eligibility.error?.message);
  const eligibleRow = Array.isArray(eligibility.data) ? eligibility.data[0] : eligibility.data;
  assert.equal(eligibleRow.eligible, true, eligibleRow.reason_message);

  const prepared = await admin.rpc('prepare_registration_contact_account_invite', { p_registration_contact_id: maria.id });
  assert.equal(prepared.error, null, prepared.error?.message);
  const invite = Array.isArray(prepared.data) ? prepared.data[0] : prepared.data;
  const mariaAuthEmail = familyEmail;
  const mariaUser = await must(service.auth.admin.createUser({ email: `maria-auth-${suffix}@qa.local`, password, email_confirm: true }), 'maria auth');
  await must(service.auth.admin.updateUserById(mariaUser.user.id, { email: mariaAuthEmail }), 'maria email');
  await must(service.from('participant_account_invites').update({ auth_user_id: mariaUser.user.id }).eq('id', invite.invite_id), 'correlate maria invite');
  const mariaClient = await clientFor(mariaAuthEmail);

  const wrongToken = await mariaClient.rpc('claim_registration_contact_account_invite', { p_invite_id: '00000000-0000-0000-0000-000000000099' });
  assert.ok(wrongToken.error);
  const stranger = await clientFor(commonEmail);
  const strangerClaim = await stranger.rpc('claim_registration_contact_account_invite', { p_invite_id: invite.invite_id });
  assert.ok(strangerClaim.error);

  const claim = await mariaClient.rpc('claim_registration_contact_account_invite', { p_invite_id: invite.invite_id });
  assert.equal(claim.error, null, claim.error?.message);

  const mariaAfter = await must(service.from('registration_contacts').select('id,user_id,full_name').eq('id', maria.id).single(), 'maria after');
  const joaoAfter = await must(service.from('registration_contacts').select('id,user_id,full_name').eq('id', joao.id).single(), 'joao after');
  const pedroAfter = await must(service.from('registration_contacts').select('id,user_id,full_name').eq('id', pedro.id).single(), 'pedro after');
  assert.equal(mariaAfter.user_id, mariaUser.user.id);
  assert.equal(joaoAfter.user_id, null);
  assert.equal(pedroAfter.user_id, null);

  const ticketsAfter = await must(service.from('tickets').select('id,owner_user_id,intended_owner_contact_id,order_item_id').in('order_item_id', imported.map((row) => row.order_item_id)), 'tickets after claim');
  assert.equal(ticketsAfter.length, 3);
  assert.ok(ticketsAfter.every((ticket) => ticket.owner_user_id === mariaUser.user.id));
  const itemsAfter = await must(service.from('order_items').select('id,registration_contact_id').in('id', imported.map((row) => row.order_item_id)), 'items after');
  const itemContacts = new Set(itemsAfter.map((item) => item.registration_contact_id));
  assert.deepEqual([...itemContacts].sort(), [joao.id, maria.id, pedro.id].sort());

  const steal = await admin.rpc('resolve_import_batch_row_review', {
    p_row_id: rows[0].id,
    p_decision: 'assign_owner_contact',
    p_registration_contact_id: joao.id,
  });
  assert.equal(steal.error, null, steal.error?.message);
  const afterStealAttempt = await must(service.from('tickets').select('owner_user_id,intended_owner_contact_id').in('order_item_id', imported.map((row) => row.order_item_id)), 'tickets after steal attempt');
  assert.ok(afterStealAttempt.every((ticket) => ticket.owner_user_id === mariaUser.user.id), 'intent pos-claim nao pode roubar owner_user_id');
  assert.ok(afterStealAttempt.every((ticket) => ticket.intended_owner_contact_id === maria.id), 'tickets ja materializados nao mudam intended silenciosamente');

  const ownerAudit = await must(service.from('audit_logs').select('action,details').eq('action', 'import_owner_contact_assigned').eq('entity_id', rows[1].id), 'owner audit');
  assert.ok(ownerAudit.length >= 1);
  const history = await must(service.from('ticket_owner_history').select('ticket_id,new_owner_user_id,reason_code').in('ticket_id', ticketsAfter.map((ticket) => ticket.id)), 'owner history');
  assert.equal(history.length, 3);
  assert.ok(history.every((row) => row.new_owner_user_id === mariaUser.user.id));

  globalThis.__m49.family = { maria, joao, pedro, mariaUserId: mariaUser.user.id, itemIds: imported.map((row) => row.order_item_id) };
});

test('CPF invalido preserva compra/ticket; convite pendente; colisao bloqueia antes do takeover', async () => {
  const invalidCpf = '12345678901';
  const pendingEmail = `cpf-pendente-${suffix}@example.invalid`;
  const fileHash = sha256(`cpf-invalido-${suffix}`);
  const batch = await createImportBatch(fileHash, 'piloto-cpf-invalido.xlsx', { payment_mode_original: 'confirm_all' });
  const row = await createRow(batch.id, 1, personNormalized({
    fullName: 'Pessoa Cpf Invalido', cpf: '', cpfInput: invalidCpf, email: pendingEmail, shirtType: 'Camiseta', shirtSize: 'M',
  }), {
    status: 'data_pending',
    data_issues: [{ field_code: 'cpf', issue_type: 'invalid_identity', message: 'CPF invalido. Compra preservada com identidade pendente.', blocks_ticket_issuance: false, blocks_payment: false, resolution_scope: 'user_resolvable' }],
    source_file_hash: fileHash,
    row_fingerprint: sha256('cpf-invalido'),
  });
  const imported = await importLine(batch.id, row.id, { fullName: 'Pessoa Cpf Invalido', cpf: invalidCpf, email: pendingEmail, shirtType: 'Camiseta', shirtSize: 'M' }, {
    issues: [{ field_code: 'cpf', issue_type: 'invalid_identity', message: 'CPF invalido', blocks_ticket_issuance: false, blocks_payment: false, resolution_scope: 'user_resolvable' }],
  });
  const contact = await must(service.from('registration_contacts').select('id,cpf,email').eq('id', imported.registration_contact_id).single(), 'invalid cpf contact');
  assert.equal(contact.cpf, null);
  const finalized = await finalizeItem(imported.order_item_id);
  assert.equal(finalized.finalization, 'paid_and_ticket_issued', JSON.stringify(finalized));
  const ticket = await must(service.from('tickets').select('id,owner_user_id,token').eq('order_item_id', imported.order_item_id).single(), 'invalid cpf ticket');
  assert.equal(ticket.owner_user_id, null);
  assert.ok(ticket.token);

  const eligibility = await admin.rpc('check_registration_contact_account_invite_eligibility', { p_registration_contact_id: contact.id });
  assert.equal(eligibility.error, null, eligibility.error?.message);
  const eligibleRow = Array.isArray(eligibility.data) ? eligibility.data[0] : eligibility.data;
  assert.equal(eligibleRow.eligible, true, eligibleRow.reason_message);

  const prepared = await admin.rpc('prepare_registration_contact_account_invite', { p_registration_contact_id: contact.id });
  assert.equal(prepared.error, null, prepared.error?.message);
  const invite = Array.isArray(prepared.data) ? prepared.data[0] : prepared.data;
  const pendingUser = await must(service.auth.admin.createUser({ email: `pending-auth-${suffix}@qa.local`, password, email_confirm: true }), 'pending auth');
  await must(service.auth.admin.updateUserById(pendingUser.user.id, { email: pendingEmail }), 'pending email');
  await must(service.from('participant_account_invites').update({ auth_user_id: pendingUser.user.id }).eq('id', invite.invite_id), 'correlate pending');
  const pendingClient = await clientFor(pendingEmail);

  const collision = await pendingClient.rpc('assert_registration_contact_cpf_available', {
    p_registration_contact_id: contact.id,
    p_cpf: douglasCpf,
  });
  assert.equal(collision.error, null, collision.error?.message);
  assert.equal(collision.data?.ok, false);
  assert.equal(collision.data?.code, 'CPF_COLLISION_REQUIRES_ADMIN');
  const stillPending = await must(service.from('registration_contacts').select('user_id,cpf').eq('id', contact.id).single(), 'still pending');
  assert.equal(stillPending.user_id, null);
  assert.equal(stillPending.cpf, null);
  const inviteStill = await must(service.from('participant_account_invites').select('status,claimed_user_id').eq('id', invite.invite_id).single(), 'invite still');
  assert.equal(inviteStill.status, 'pending');
  const douglasStill = await must(service.from('registration_contacts').select('id,cpf').eq('cpf', douglasCpf).maybeSingle(), 'douglas untouched');
  assert.ok(douglasStill?.id);

  const uniqueCpf = generateValidCpf();
  const available = await pendingClient.rpc('assert_registration_contact_cpf_available', {
    p_registration_contact_id: contact.id,
    p_cpf: uniqueCpf,
  });
  assert.equal(available.error, null, available.error?.message);
  assert.equal(available.data?.ok, true);

  const collisionAudit = await must(service.from('audit_logs').select('action,details').eq('action', 'import_cpf_collision').eq('entity_id', contact.id), 'collision audit');
  assert.ok(collisionAudit.length >= 1);
  assert.equal(collisionAudit[0].details?.stage, 'first_access_preclaim');
});

test('CPF 10 digitos: confirmacao, outro CPF e manter pendente sao auditados', async () => {
  const validWithZero = generateValidCpfStartingWithZero();
  const tenDigits = validWithZero.slice(1);
  const fileHash = sha256(`excel-cpf-${suffix}`);
  const batch = await createImportBatch(fileHash, 'piloto-excel-cpf.xlsx', { total_rows: 3, status: 'ready_for_review' });
  const confirmRow = await createRow(batch.id, 1, personNormalized({
    fullName: 'Excel Confirm', cpf: tenDigits, cpfInput: tenDigits, email: `excel-a-${suffix}@example.invalid`,
  }), {
    status: 'review_required', resolution: 'pending',
    cpf_excel_candidate: validWithZero, cpf_cell_kind: 'number',
    identity_match_details: { reason: 'excel_leading_zero', excel_cpf: { original: tenDigits, suggested: validWithZero } },
  });
  const otherRow = await createRow(batch.id, 2, personNormalized({
    fullName: 'Excel Outro', cpf: tenDigits, cpfInput: tenDigits, email: `excel-b-${suffix}@example.invalid`,
  }), {
    status: 'review_required', resolution: 'pending',
    cpf_excel_candidate: validWithZero, cpf_cell_kind: 'number',
    identity_match_details: { reason: 'excel_leading_zero' },
  });
  const keepRow = await createRow(batch.id, 3, personNormalized({
    fullName: 'Excel Pendente', cpf: tenDigits, cpfInput: tenDigits, email: `excel-c-${suffix}@example.invalid`,
  }), {
    status: 'review_required', resolution: 'pending',
    cpf_excel_candidate: validWithZero, cpf_cell_kind: 'number',
    identity_match_details: { reason: 'excel_leading_zero' },
  });

  const confirmed = await admin.rpc('resolve_import_batch_row_review', { p_row_id: confirmRow.id, p_decision: 'confirm_excel_cpf' });
  assert.equal(confirmed.error, null, confirmed.error?.message);
  const alternateCpf = generateValidCpf();
  const overridden = await admin.rpc('resolve_import_batch_row_review', {
    p_row_id: otherRow.id, p_decision: 'provide_alternate_cpf', p_payload: { cpf: alternateCpf },
  });
  assert.equal(overridden.error, null, overridden.error?.message);
  const kept = await admin.rpc('resolve_import_batch_row_review', { p_row_id: keepRow.id, p_decision: 'keep_pending_cpf' });
  assert.equal(kept.error, null, kept.error?.message);

  const afterConfirm = await must(service.from('import_batch_rows').select('status,normalized_data,review_decision').eq('id', confirmRow.id).single(), 'confirm excel');
  assert.equal(afterConfirm.review_decision, 'confirm_excel_cpf');
  assert.equal(afterConfirm.normalized_data.cpf, validWithZero);
  const afterOther = await must(service.from('import_batch_rows').select('normalized_data,review_decision').eq('id', otherRow.id).single(), 'other excel');
  assert.equal(afterOther.normalized_data.cpf, alternateCpf);
  const afterKeep = await must(service.from('import_batch_rows').select('status,review_decision').eq('id', keepRow.id).single(), 'keep excel');
  assert.equal(afterKeep.status, 'data_pending');
  assert.equal(afterKeep.review_decision, 'keep_pending_cpf');

  const excelAudits = await must(service.from('audit_logs').select('action').in('action', ['import_excel_cpf_confirmed', 'import_excel_cpf_overridden', 'import_cpf_kept_pending']), 'excel audits');
  assert.ok(excelAudits.some((entry) => entry.action === 'import_excel_cpf_confirmed'));
  assert.ok(excelAudits.some((entry) => entry.action === 'import_excel_cpf_overridden'));
  assert.ok(excelAudits.some((entry) => entry.action === 'import_cpf_kept_pending'));
});

test('CSV preserva zero; XLSX numerico nao ganha zero silenciosamente', () => {
  const validWithZero = generateValidCpfStartingWithZero();
  const tenDigits = validWithZero.slice(1);
  const csv = parseCsvLike(`nome,cpf\nDouglas Teste,${validWithZero}`);
  assert.equal(csv[0].cpf, validWithZero);

  const textBook = XLSX.utils.book_new();
  const textSheet = XLSX.utils.aoa_to_sheet([['nome', 'cpf'], ['Douglas Teste', validWithZero]]);
  textSheet.B2.t = 's';
  textSheet.B2.v = validWithZero;
  textSheet.B2.w = validWithZero;
  XLSX.utils.book_append_sheet(textBook, textSheet, 's');
  const textBuf = XLSX.write(textBook, { type: 'buffer', bookType: 'xlsx' });
  const textParsed = parseXlsxLike(textBuf);
  assert.equal(String(textParsed.formatted[0].cpf), validWithZero);
  assert.notEqual(textParsed.rawKind, 'number');

  const numBook = XLSX.utils.book_new();
  const numSheet = XLSX.utils.aoa_to_sheet([['nome', 'cpf'], ['Douglas Teste', Number(tenDigits)]]);
  XLSX.utils.book_append_sheet(numBook, numSheet, 's');
  const numBuf = XLSX.write(numBook, { type: 'buffer', bookType: 'xlsx' });
  const numParsed = parseXlsxLike(numBuf);
  assert.equal(numParsed.rawKind, 'number');
  assert.notEqual(String(numParsed.raw[0].cpf).padStart(11, '0'), String(numParsed.raw[0].cpf));
  assert.equal(String(numParsed.raw[0].cpf).startsWith('0'), false);
});

test('external_purchase_key diferente gera duas compras; repetir a chave ja materializada fica no contrato de revisao', async () => {
  const cpf = generateValidCpf();
  const fileHash = sha256(`extkey-${suffix}`);
  const batch = await createImportBatch(fileHash, 'piloto-extkey.xlsx', { total_rows: 2 });
  const person = { fullName: 'Externo Teste', cpf, email: `ext-${suffix}@example.invalid`, shirtType: 'Camiseta', shirtSize: 'M' };
  const row1 = await createRow(batch.id, 1, personNormalized(person), {
    external_purchase_key: 'PED-001', row_fingerprint: sha256('ext-1'), source_file_hash: fileHash,
  });
  const row2 = await createRow(batch.id, 2, personNormalized(person), {
    external_purchase_key: 'PED-002', row_fingerprint: sha256('ext-2'), source_file_hash: fileHash,
  });
  const a = await importLine(batch.id, row1.id, person);
  const b = await importLine(batch.id, row2.id, person);
  assert.equal(a.registration_contact_id, b.registration_contact_id);
  assert.notEqual(a.order_id, b.order_id);
  const keys = await must(service.from('import_batch_rows').select('external_purchase_key').eq('import_batch_id', batch.id), 'keys');
  assert.deepEqual(keys.map((row) => row.external_purchase_key).sort(), ['PED-001', 'PED-002']);
});

test('payment pending vs confirm_all: identidade pendente nao vira payment pending automaticamente', async () => {
  const pendingCpf = generateValidCpf();
  const pendingHash = sha256(`pay-pending-${suffix}`);
  const pendingBatch = await createImportBatch(pendingHash, 'piloto-pending.xlsx', { payment_mode_original: 'pending' });
  const pendingPerson = { fullName: 'Pagamento Pendente', cpf: pendingCpf, email: `pay-p-${suffix}@example.invalid` };
  const pendingRow = await createRow(pendingBatch.id, 1, personNormalized(pendingPerson), { source_file_hash: pendingHash, row_fingerprint: sha256('pay-p') });
  const pendingImported = await importLine(pendingBatch.id, pendingRow.id, pendingPerson);
  const pendingFinal = await admin.rpc('finalize_imported_ticket_after_issue_resolution', {
    p_order_item_id: pendingImported.order_item_id, p_resolved_fields: [],
  });
  assert.equal(pendingFinal.error, null, pendingFinal.error?.message);
  assert.equal(pendingFinal.data.finalization, 'payment_pending');
  const pendingPayment = await must(service.from('payments').select('payment_status').eq('id', pendingImported.payment_id).single(), 'pending payment');
  assert.equal(pendingPayment.payment_status, 'pending');

  const confirmHash = sha256(`pay-confirm-${suffix}`);
  const confirmBatch = await createImportBatch(confirmHash, 'piloto-confirm.xlsx', { payment_mode_original: 'confirm_all' });
  const invalidPerson = { fullName: 'Confirm Com Cpf Pendente', cpf: '00000000000', email: `pay-c-${suffix}@example.invalid` };
  const confirmRow = await createRow(confirmBatch.id, 1, personNormalized({ ...invalidPerson, cpf: '', cpfInput: '00000000000' }), {
    source_file_hash: confirmHash, row_fingerprint: sha256('pay-c'),
    data_issues: [{ field_code: 'cpf', issue_type: 'invalid_identity', blocks_ticket_issuance: false, blocks_payment: false }],
  });
  const confirmImported = await importLine(confirmBatch.id, confirmRow.id, invalidPerson, {
    issues: [{ field_code: 'cpf', issue_type: 'invalid_identity', message: 'CPF invalido. Compra preservada com identidade pendente.', blocks_ticket_issuance: false, blocks_payment: false }],
  });
  const confirmFinal = await finalizeItem(confirmImported.order_item_id);
  assert.equal(confirmFinal.finalization, 'paid_and_ticket_issued');
  const confirmPayment = await must(service.from('payments').select('payment_status').eq('id', confirmImported.payment_id).single(), 'confirm payment');
  assert.equal(confirmPayment.payment_status, 'paid');
  const confirmTicket = await must(service.from('tickets').select('owner_user_id,token').eq('id', confirmFinal.ticket_id).single(), 'confirm ticket');
  assert.equal(confirmTicket.owner_user_id, null);
  const otherTokens = await must(service.from('tickets').select('id').eq('token', confirmTicket.token), 'unique token');
  assert.equal(otherTokens.length, 1);
});

test('UI discoverability: admin encontra as decisoes sem saber o nome da RPC', async () => {
  const importClient = await readFile(new URL('../src/app/importacoes/ImportacoesClient.tsx', import.meta.url), 'utf8');
  const reviews = await readFile(new URL('../src/app/importacoes/revisoes/page.tsx', import.meta.url), 'utf8');
  const firstAccess = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');
  assert.match(importClient, /Este arquivo já foi importado anteriormente/);
  assert.match(reviews, /Esta é nova compra/);
  assert.match(reviews, /Já foi importada \/ ignorar duplicação técnica/);
  assert.match(reviews, /Usar esta Pessoa como conta dos ingressos/);
  assert.match(reviews, /Manter Pessoas separadas/);
  assert.match(reviews, /Possível zero inicial removido pelo Excel/);
  assert.match(reviews, /Confirmar CPF sugerido/);
  assert.match(reviews, /Manter como CPF pendente/);
  assert.match(firstAccess, /invite/);
});

function parseCsvLike(content) {
  const [header, ...lines] = content.trim().split(/\r?\n/);
  const keys = header.split(',');
  return lines.map((line) => {
    const values = line.split(',');
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  });
}

function parseXlsxLike(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const formatted = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
  const rawKind = typeof raw[0]?.cpf === 'number' ? 'number' : typeof raw[0]?.cpf;
  return { formatted, raw, rawKind };
}
