// Gate SQL/RPC LOCAL apos 20261110. Nao toca producao. Nao limpa os 29.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';
import {
  cadastroAppearsInListing,
  classifyCadastroListing,
  countCadastroOwnedOperationalTickets,
  matchesCadastroListingQuery,
} from '../src/lib/registrations/cadastro-listing.ts';
import { isImportRowReadyToImport } from '../src/lib/imports/batch-operational-state.ts';

const API = 'http://127.0.0.1:15421';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const password = 'SenhaForte!123';

function psql(sql) {
  return execFileSync('docker', ['exec', 'supabase_db_militrin-manager', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c', sql], { encoding: 'utf8' }).trim();
}

function generateValidCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  function checkDigit(nums) {
    let sum = 0;
    let weight = nums.length + 1;
    for (const n of nums) {
      sum += n * weight;
      weight -= 1;
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  }
  const d1 = checkDigit(base);
  const d2 = checkDigit([...base, d1]);
  return [...base, d1, d2].join('');
}

async function ping() {
  try {
    const response = await fetch(`${API}/auth/v1/health`);
    return response.ok;
  } catch {
    return false;
  }
}

if (!await ping()) {
  test('cadastros titulares local: supabase 15421 ausente', () => {
    assert.fail('Supabase local em 127.0.0.1:15421 precisa estar no ar para este gate.');
  });
} else {
  const service = createClient(API, SERVICE, options);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }

  const org = await must(service.from('organizations').insert({
    name: 'Cadastro Titulares Local', slug: `cad-tit-${suffix}`, status: 'active',
  }).select('id').single(), 'org');
  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Militrin Local Gate', year: 2032, slug: `cad-tit-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2032-10-10T12:00:00Z', min_age: 0,
  }).select('id').single(), 'event');
  const category = await must(service.from('ticket_categories').insert({
    event_id: event.id, name: 'Geral', slug: `cad-tit-geral-${suffix}`, is_active: true,
  }).select('id').single(), 'category');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100,
    max_confirmed_registrations: 200, is_active: true,
  }).select('id').single(), 'batch');
  await must(service.from('registration_batch_prices').insert({
    batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100,
  }), 'prices');

  const adminEmail = `cad-tit-admin-${suffix}@qa.local`;
  const adminCreated = await must(service.auth.admin.createUser({
    email: adminEmail, password, email_confirm: true,
  }), 'admin auth');
  const adminId = adminCreated.user.id;
  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  await must(service.from('organization_members').insert({
    organization_id: org.id, user_id: adminId, role_id: ownerRole.id, is_owner: true, is_active: true,
  }), 'membership');
  await must(service.from('admin_users').insert({
    user_id: adminId, role_id: ownerRole.id, is_active: true,
  }), 'admin_users');
  const anon = createClient(API, ANON, options);
  assert.equal((await anon.auth.signInWithPassword({ email: adminEmail, password })).error, null);

  async function openImportRow({ rowNumber, fullName, cpf, email, resolution = 'create_new', identityMode = null, intendedOwner = null }) {
    const importBatch = await must(service.from('import_batches').insert({
      import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id,
      imported_by: adminId, file_name: `cad-tit-${suffix}-${rowNumber}.csv`, total_rows: 1, status: 'processing',
    }).select('id').single(), `import batch ${rowNumber}`);
    const details = identityMode ? { identity_mode: identityMode } : {};
    const row = await must(service.from('import_batch_rows').insert({
      import_batch_id: importBatch.id, row_number: rowNumber,
      status: resolution === 'pending' ? 'review_required' : 'ready',
      resolution,
      intended_owner_contact_id: intendedOwner,
      identity_match_details: details,
      normalized_data: {
        full_name: fullName, cpf, cpf_input: cpf, email, amount: '100', price_origin: 'legacy_provided',
      },
      raw_data: {},
    }).select('id').single(), `import row ${rowNumber}`);
    return { importBatch, row };
  }

  async function importContactFirst({ row, fullName, cpf, email, identityMode = 'cadastro', expectedContact = null, intendedOwner = null }) {
    return anon.rpc('import_current_event_contact_first', {
      p_import_batch_id: row.importBatch.id,
      p_import_batch_row_id: row.row.id,
      p_expected_registration_contact_id: expectedContact,
      p_full_name: fullName,
      p_cpf: cpf,
      p_birth_date: '1990-05-10',
      p_gender: 'female',
      p_phone: '11999998888',
      p_email: email,
      p_city: 'Itapiranga',
      p_shirt_type: null,
      p_shirt_size: null,
      p_registration_batch_id: batch.id,
      p_ticket_category_id: category.id,
      p_payment_method: 'pix',
      p_import_issues: [],
      p_assign_holder: true,
      p_intended_owner_contact_id: intendedOwner,
      ...(identityMode == null ? {} : { p_identity_mode: identityMode }),
    });
  }

  await test('overloads: so a assinatura 19-arg permanece; apply_shared_email existe', () => {
    const applied = psql("select version from supabase_migrations.schema_migrations where version='20261110000000'");
    assert.equal(applied, '20261110000000');
    const importArgs = psql("select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='import_current_event_contact_first'");
    const lines = importArgs.split(/\r?\n/).filter(Boolean);
    assert.equal(lines.length, 1, `overloads inesperados: ${importArgs}`);
    assert.match(lines[0], /p_identity_mode text/);
    assert.doesNotMatch(importArgs, /p_identity_mode text,/);
    const holderFn = psql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='apply_shared_email_textual_holders'");
    assert.equal(holderFn, '1');
  });

  const principalCpf = generateValidCpf();
  const principalEmail = `barbara-like-${suffix}@qa.local`;
  const principalName = 'Barbara Zuge Local';
  let principalContactId;
  let principalImport;

  await test('cadastro: pessoa principal cria/reutiliza registration_contact', async () => {
    principalImport = await openImportRow({
      rowNumber: 1, fullName: principalName, cpf: principalCpf, email: principalEmail,
    });
    const first = await importContactFirst({
      row: principalImport, fullName: principalName, cpf: principalCpf, email: principalEmail, identityMode: 'cadastro',
    });
    assert.equal(first.error, null, first.error?.message);
    assert.equal(first.data.created_contact, true);
    assert.ok(first.data.registration_contact_id);
    assert.ok(first.data.participant_id);
    assert.equal(first.data.identity_mode, 'cadastro');
    principalContactId = first.data.registration_contact_id;
    const contacts = await must(
      service.from('registration_contacts').select('id').eq('organization_id', org.id).eq('full_name', principalName),
      'principal contacts',
    );
    assert.equal(contacts.length, 1);
  });

  await test('callers antigos: omitir p_identity_mode continua cadastro (default)', async () => {
    const cpf = generateValidCpf();
    const name = `Principal Default ${suffix}`;
    const row = await openImportRow({ rowNumber: 2, fullName: name, cpf, email: `default-${suffix}@qa.local` });
    const result = await importContactFirst({
      row, fullName: name, cpf, email: `default-${suffix}@qa.local`, identityMode: null,
    });
    assert.equal(result.error, null, result.error?.message);
    assert.equal(result.data.created_contact, true);
    assert.equal(result.data.identity_mode, 'cadastro');
    assert.ok(result.data.registration_contact_id);
  });

  await test('textual_holder: nao cria contact, participant nem Auth', async () => {
    const holderName = 'Bruno Gambatto Local';
    const contactsBefore = await must(
      service.from('registration_contacts').select('id').eq('organization_id', org.id),
      'contacts before textual',
    );
    const participantsBefore = await must(
      service.from('participants').select('id').eq('organization_id', org.id),
      'participants before textual',
    );
    const authBefore = Number(psql('select count(*) from auth.users'));
    const row = await openImportRow({
      rowNumber: 3, fullName: holderName, cpf: null, email: `bruno-${suffix}@qa.local`,
      resolution: 'textual_holder', identityMode: 'textual_holder', intendedOwner: principalContactId,
    });
    const result = await importContactFirst({
      row, fullName: holderName, cpf: null, email: `bruno-${suffix}@qa.local`,
      identityMode: 'textual_holder', intendedOwner: principalContactId,
    });
    assert.equal(result.error, null, result.error?.message);
    assert.equal(result.data.created_contact, false);
    assert.equal(result.data.registration_contact_id, null);
    assert.equal(result.data.participant_id, null);
    assert.equal(result.data.identity_mode, 'textual_holder');
    assert.ok(result.data.order_item_id);
    const item = await must(
      service.from('order_items').select('holder_full_name,registration_contact_id,participant_id,intended_owner_contact_id').eq('id', result.data.order_item_id).single(),
      'textual item',
    );
    assert.equal(item.holder_full_name, holderName);
    assert.equal(item.registration_contact_id, null);
    assert.equal(item.participant_id, null);
    assert.equal(item.intended_owner_contact_id, principalContactId);
    const brunoContacts = await must(
      service.from('registration_contacts').select('id').eq('organization_id', org.id).eq('full_name', holderName),
      'bruno contacts',
    );
    assert.equal(brunoContacts.length, 0);
    const contactsAfter = await must(
      service.from('registration_contacts').select('id').eq('organization_id', org.id),
      'contacts after textual',
    );
    const participantsAfter = await must(
      service.from('participants').select('id').eq('organization_id', org.id),
      'participants after textual',
    );
    assert.equal(contactsAfter.length, contactsBefore.length);
    assert.equal(participantsAfter.length, participantsBefore.length);
    assert.equal(Number(psql('select count(*) from auth.users')), authBefore);
  });

  await test('review ambigua: textual sem owner falha; pending nao importa sozinho', async () => {
    assert.equal(isImportRowReadyToImport('review_required', 'pending'), false);
    const row = await openImportRow({
      rowNumber: 4, fullName: 'Titular Ambiguo', cpf: null, email: `amb-${suffix}@qa.local`,
      resolution: 'textual_holder', identityMode: 'textual_holder',
    });
    const result = await importContactFirst({
      row, fullName: 'Titular Ambiguo', cpf: null, email: `amb-${suffix}@qa.local`, identityMode: 'textual_holder',
    });
    assert.ok(result.error, 'textual sem owner deveria falhar');
    assert.match(result.error.message, /Titular textual exige a conta proprietaria/i);
    const ghost = await must(
      service.from('registration_contacts').select('id').eq('organization_id', org.id).eq('full_name', 'Titular Ambiguo'),
      'ambiguous ghost',
    );
    assert.equal(ghost.length, 0);
  });

  await test('shared-email: assign_owner marca so a linha adicional como textual', async () => {
    const shared = `shared-${suffix}@qa.local`;
    const jeanName = 'Jean Lucas Local';
    const importBatch = await must(service.from('import_batches').insert({
      import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id,
      imported_by: adminId, file_name: `shared-${suffix}.csv`, total_rows: 2, status: 'processing',
    }).select('id').single(), 'shared batch');
    const ownerRow = await must(service.from('import_batch_rows').insert({
      import_batch_id: importBatch.id, row_number: 10, status: 'ready', resolution: 'create_new',
      registration_contact_id: principalContactId,
      normalized_data: { full_name: principalName, email: shared, cpf: principalCpf },
      identity_match_details: {},
    }).select('id,registration_contact_id').single(), 'shared owner row');
    const extraRow = await must(service.from('import_batch_rows').insert({
      import_batch_id: importBatch.id, row_number: 11, status: 'review_required', resolution: 'pending',
      normalized_data: { full_name: jeanName, email: shared },
      identity_match_details: { account_review: 'shared_email' },
    }).select('id,resolution,status').single(), 'shared extra row');
    const applied = await anon.rpc('apply_shared_email_textual_holders', {
      p_row_id: extraRow.id,
      p_owner_contact_id: principalContactId,
    });
    assert.equal(applied.error, null, applied.error?.message);
    assert.equal(applied.data.success, true);
    const extraAfter = await must(
      service.from('import_batch_rows').select('resolution,status,intended_owner_contact_id,identity_match_details').eq('id', extraRow.id).single(),
      'extra after',
    );
    const ownerAfter = await must(
      service.from('import_batch_rows').select('resolution,registration_contact_id').eq('id', ownerRow.id).single(),
      'owner after',
    );
    assert.equal(extraAfter.resolution, 'textual_holder');
    assert.equal(extraAfter.intended_owner_contact_id, principalContactId);
    assert.equal(extraAfter.identity_match_details.identity_mode, 'textual_holder');
    assert.equal(ownerAfter.resolution, 'create_new');
    assert.equal(ownerAfter.registration_contact_id, principalContactId);
  });

  await test('idempotencia: reimportar a mesma linha nao duplica contact/pedido', async () => {
    const again = await importContactFirst({
      row: principalImport, fullName: principalName, cpf: principalCpf, email: principalEmail, identityMode: 'cadastro',
    });
    assert.equal(again.error, null, again.error?.message);
    assert.equal(again.data.created_contact, false);
    assert.equal(again.data.registration_contact_id, principalContactId);
    const contacts = await must(
      service.from('registration_contacts').select('id').eq('organization_id', org.id).eq('full_name', principalName),
      'principal after idem',
    );
    assert.equal(contacts.length, 1);
  });

  await test('A/B/C/E + Barbara 2/1 + Danieli 2 e Jean nao e Cadastro', async () => {
    const barbaraAuth = await must(service.auth.admin.createUser({
      email: `barbara-${suffix}@qa.local`, password, email_confirm: true,
    }), 'barbara auth');
    const danieliAuth = await must(service.auth.admin.createUser({
      email: `danieli-${suffix}@qa.local`, password, email_confirm: true,
    }), 'danieli auth');
    const barbara = await must(service.from('registration_contacts').insert({
      organization_id: org.id, full_name: 'Barbara Zuge', user_id: barbaraAuth.user.id,
      email: `barbara-${suffix}@qa.local`, cpf: generateValidCpf(), birth_date: '1992-01-01',
    }).select('id,user_id').single(), 'barbara contact');
    const danieli = await must(service.from('registration_contacts').insert({
      organization_id: org.id, full_name: 'Danieli Weber da Conceicao', user_id: danieliAuth.user.id,
      email: `danieli-${suffix}@qa.local`, cpf: generateValidCpf(), birth_date: '1991-01-01',
    }).select('id,user_id').single(), 'danieli contact');
    const jean = await must(service.from('registration_contacts').insert({
      organization_id: org.id, full_name: 'Jean Lucas Pinheiro Rodrigues',
      email: `jean-${suffix}@qa.local`, cpf: generateValidCpf(), birth_date: '1993-01-01',
    }).select('id,user_id').single(), 'jean contact');
    const pending = await must(service.from('registration_contacts').insert({
      organization_id: org.id, full_name: 'Pessoa Convite B',
      email: `pending-${suffix}@qa.local`, cpf: generateValidCpf(), birth_date: '1994-01-01',
    }).select('id,user_id').single(), 'pending contact');
    const legacy = await must(service.from('registration_contacts').insert({
      organization_id: org.id, full_name: 'Maria Eduarda C',
      email: `legacy-${suffix}@qa.local`, cpf: generateValidCpf(), birth_date: '1995-01-01',
    }).select('id,user_id').single(), 'legacy contact');
    await must(service.from('participant_account_invites').insert({
      organization_id: org.id, registration_contact_id: pending.id, status: 'pending',
      email: `pending-${suffix}@qa.local`, invited_by: adminId,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      requires_password_setup: true,
    }), 'pending invite');

    async function ticketFor({ ownerUserId, holderName, holderContactId, intendedOwnerContactId, status = 'active', label, imported = false, importBatchId = null }) {
      const order = await must(service.from('orders').insert({
        organization_id: org.id, event_id: event.id, user_id: imported ? null : ownerUserId,
        import_batch_id: imported ? importBatchId : null,
        order_number: `${label}-${suffix}-${Math.floor(Math.random() * 100000)}`,
        status: 'confirmed', base_amount: 100, final_amount: 100,
        buyer_type: imported ? 'imported_holder' : 'account',
      }).select('id').single(), `order ${label}`);
      const item = await must(service.from('order_items').insert({
        order_id: order.id, event_id: event.id, registration_contact_id: holderContactId,
        intended_owner_contact_id: intendedOwnerContactId, item_kind: 'ticket',
        ticket_category_id: category.id, batch_id: batch.id, quantity: 1, unit_price: 100,
        discount_amount: 0, final_amount: 100, status: 'confirmed', ownership_status: 'assigned',
        holder_full_name: holderName,
      }).select('id').single(), `item ${label}`);
      return must(service.from('tickets').insert({
        order_id: order.id, order_item_id: item.id, event_id: event.id, organization_id: org.id,
        status, owner_user_id: ownerUserId, intended_owner_contact_id: intendedOwnerContactId,
      }).select('id,event_id,status,owner_user_id,intended_owner_contact_id').single(), `ticket ${label}`);
    }

    const t1933 = await ticketFor({
      ownerUserId: barbara.user_id, holderName: 'Barbara Zuge', holderContactId: barbara.id,
      intendedOwnerContactId: barbara.id, label: '1933',
    });
    const t1935 = await ticketFor({
      ownerUserId: barbara.user_id, holderName: 'Bruno Gambatto', holderContactId: null,
      intendedOwnerContactId: null, label: '1935',
    });
    const t1566 = await ticketFor({
      ownerUserId: danieli.user_id, holderName: 'Danieli Weber da Conceicao', holderContactId: danieli.id,
      intendedOwnerContactId: danieli.id, label: '1566',
    });
    const t1574 = await ticketFor({
      ownerUserId: danieli.user_id, holderName: 'Jean Lucas Pinheiro Rodrigues', holderContactId: jean.id,
      intendedOwnerContactId: danieli.id, label: '1574',
    });
    const classFixtureBatch = await must(service.from('import_batches').insert({
      import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id,
      imported_by: adminId, file_name: `class-${suffix}.csv`, total_rows: 1, status: 'processing',
    }).select('id').single(), 'class fixture batch');
    await ticketFor({
      ownerUserId: null, holderName: 'Maria Eduarda C', holderContactId: legacy.id,
      intendedOwnerContactId: legacy.id, label: 'legacy', imported: true, importBatchId: classFixtureBatch.id,
    });
    await ticketFor({
      ownerUserId: barbara.user_id, holderName: 'Barbara cancelled', holderContactId: barbara.id,
      intendedOwnerContactId: barbara.id, status: 'cancelled', label: 'cancelled',
    });

    const listingTickets = [t1933, t1935, t1566, t1574].map((ticket) => ({
      ticketId: ticket.id,
      eventId: ticket.event_id,
      status: ticket.status,
      ownerUserId: ticket.owner_user_id,
      intendedOwnerContactId: ticket.intended_owner_contact_id,
      holderContactId: null,
    }));
    listingTickets[0].holderContactId = barbara.id;
    listingTickets[1].holderContactId = null;
    listingTickets[2].holderContactId = danieli.id;
    listingTickets[3].holderContactId = jean.id;
    const legacyTicket = (await must(
      service.from('tickets').select('id,event_id,status,owner_user_id,intended_owner_contact_id').eq('organization_id', org.id).eq('intended_owner_contact_id', legacy.id).single(),
      'legacy ticket',
    ));
    listingTickets.push({
      ticketId: legacyTicket.id, eventId: legacyTicket.event_id, status: legacyTicket.status,
      ownerUserId: legacyTicket.owner_user_id, intendedOwnerContactId: legacyTicket.intended_owner_contact_id,
      holderContactId: legacy.id,
    });
    const cancelled = await must(
      service.from('tickets').select('id,event_id,status,owner_user_id,intended_owner_contact_id').eq('organization_id', org.id).eq('status', 'cancelled').limit(1).maybeSingle(),
      'cancelled ticket',
    );
    listingTickets.push({
      ticketId: cancelled.id, eventId: cancelled.event_id, status: cancelled.status,
      ownerUserId: cancelled.owner_user_id, intendedOwnerContactId: cancelled.intended_owner_contact_id,
      holderContactId: barbara.id,
    });

    const barbaraStats = countCadastroOwnedOperationalTickets({ contactId: barbara.id, userId: barbara.user_id }, listingTickets);
    const danieliStats = countCadastroOwnedOperationalTickets({ contactId: danieli.id, userId: danieli.user_id }, listingTickets);
    assert.equal(classifyCadastroListing({ contactId: barbara.id, userId: barbara.user_id }, listingTickets), 'A');
    assert.equal(classifyCadastroListing({ contactId: pending.id, userId: null, hasPendingFirstAccessInvite: true }, listingTickets), 'B');
    assert.equal(classifyCadastroListing({ contactId: legacy.id, userId: null }, listingTickets), 'C');
    assert.equal(classifyCadastroListing({ contactId: jean.id, userId: null }, listingTickets), 'E');
    assert.equal(barbaraStats.ticketCount, 2);
    assert.equal(barbaraStats.eventCount, 1);
    assert.equal(danieliStats.ticketCount, 2);
    assert.equal(cadastroAppearsInListing('E'), false);
    const visible = [barbara, danieli, jean, pending, legacy].filter((contact) => (
      cadastroAppearsInListing(classifyCadastroListing({
        contactId: contact.id,
        userId: contact.user_id,
        hasPendingFirstAccessInvite: contact.id === pending.id,
      }, listingTickets))
    ));
    assert.deepEqual(visible.map((contact) => contact.id).sort(), [barbara.id, danieli.id, pending.id, legacy.id].sort());
    assert.equal(visible.some((contact) => contact.id === jean.id), false);
    assert.equal(matchesCadastroListingQuery({ name: 'Jean Lucas Pinheiro Rodrigues' }, 'Jean'), true);
    assert.equal(cadastroAppearsInListing('E'), false);
  });
}
