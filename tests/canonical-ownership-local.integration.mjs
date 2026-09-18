// Gates reais contra Supabase LOCAL apos 20261106.
// Nao toca producao.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

const API = 'http://127.0.0.1:15421';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const options = { auth: { persistSession: false, autoRefreshToken: false } };

async function ping() {
  try {
    const response = await fetch(`${API}/auth/v1/health`);
    return response.ok;
  } catch {
    return false;
  }
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

if (!await ping()) {
  test('canonical ownership local: supabase 15421 ausente', () => {
    assert.fail('Supabase local em 127.0.0.1:15421 precisa estar no ar para este gate.');
  });
} else {
  const service = createClient(API, SERVICE, options);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';

  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }

  async function clientFor(email) {
    const client = createClient(API, ANON, options);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`login ${email}: ${signIn.error.message}`);
    return client;
  }

  async function historyFor(ticketId) {
    return must(
      service.from('ticket_owner_history').select('operation,previous_owner_user_id,new_owner_user_id,reason_code,reason_text,created_at').eq('ticket_id', ticketId).order('created_at'),
      `history ${ticketId}`,
    );
  }

  const org = await must(service.from('organizations').insert({
    name: 'Canonical Ownership Local', slug: `can-own-${suffix}`,
  }).select('id').single(), 'org');
  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Canonical', year: 2031, slug: `can-own-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2031-10-10T12:00:00Z', min_age: 0,
  }).select('id').single(), 'event');
  const category = await must(service.from('ticket_categories').insert({
    event_id: event.id, name: 'Geral', slug: `can-own-geral-${suffix}`, is_active: true,
  }).select('id').single(), 'category');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100,
    max_confirmed_registrations: 100, is_active: true,
  }).select('id').single(), 'batch');
  await must(service.from('registration_batch_prices').insert({
    batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100,
  }), 'prices');

  async function makeAdmin(label) {
    const email = `can-admin-${label}-${suffix}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `admin ${label}`);
    await must(service.from('customer_profiles').upsert({
      user_id: created.user.id, cpf: generateValidCpf(), full_name: label, birth_date: '1990-05-05',
      phone: '11999990001', city: 'Itapiranga', gender: 'male',
    }, { onConflict: 'user_id' }), `${label} profile`);
    const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
    await must(service.from('organization_members').insert({
      organization_id: org.id, user_id: created.user.id, is_owner: true, is_active: true,
    }), `${label} member`);
    await must(service.from('admin_users').insert({
      user_id: created.user.id, role_id: ownerRole.id, is_active: true,
    }), `${label} admin_users`);
    return { client: await clientFor(email), userId: created.user.id, email };
  }

  async function createPendingIdentity({ label, email, cpf, buyerType, status = 'active', orderUserId = null, intendedSelf = true }) {
    const contact = await must(service.from('registration_contacts').insert({
      organization_id: org.id, full_name: label, cpf, birth_date: '1988-03-15',
      gender: 'female', phone: '11988887777', email, city: 'Itapiranga',
    }).select('id,user_id,full_name').single(), `contact ${label}`);
    const participant = await must(service.from('participants').insert({
      organization_id: org.id, event_id: event.id, registration_contact_id: contact.id,
      full_name: label, cpf, email, birth_date: '1988-03-15', gender: 'female',
      phone: '11988887777', city: 'Itapiranga', registration_status: 'confirmed',
    }).select('id,user_id').single(), `participant ${label}`);
    const order = await must(service.from('orders').insert({
      organization_id: org.id, event_id: event.id, participant_id: participant.id,
      user_id: orderUserId,
      import_batch_id: buyerType === 'imported_holder' ? importBatch.id : null,
      order_number: `CAN-${label}-${suffix}-${Math.floor(Math.random() * 100000)}`,
      status: 'confirmed', base_amount: 100, final_amount: 100, buyer_type: buyerType,
    }).select('id,user_id,buyer_type').single(), `order ${label}`);
    const item = await must(service.from('order_items').insert({
      order_id: order.id, event_id: event.id, participant_id: participant.id,
      registration_contact_id: contact.id, item_kind: 'ticket', ticket_category_id: category.id,
      batch_id: batch.id, quantity: 1, unit_price: 100, discount_amount: 0, final_amount: 100,
      status: 'confirmed', ownership_status: 'assigned', holder_full_name: label,
      intended_owner_contact_id: intendedSelf ? contact.id : null,
    }).select('id,intended_owner_contact_id,registration_contact_id').single(), `item ${label}`);
    const ticket = await must(service.from('tickets').insert({
      order_id: order.id, order_item_id: item.id, participant_id: participant.id,
      event_id: event.id, organization_id: org.id, status,
      intended_owner_contact_id: intendedSelf ? contact.id : null,
    }).select('id,owner_user_id,intended_owner_contact_id,status').single(), `ticket ${label}`);
    return { contact, participant, order, item, ticket, cpf, email, label };
  }

  async function claimContact(admin, identity, authEmail) {
    const created = await must(service.auth.admin.createUser({
      email: authEmail, password, email_confirm: true,
    }), `auth ${authEmail}`);
    const authUserId = created.user.id;
    await must(service.from('customer_profiles').upsert({
      user_id: authUserId, account_status: 'pending_activation',
      must_change_password: true, must_complete_profile: true,
    }, { onConflict: 'user_id' }), `profile ${authEmail}`);
    const prepared = await must(admin.client.rpc('prepare_registration_contact_account_invite', {
      p_registration_contact_id: identity.contact.id,
    }), `prepare ${authEmail}`);
    const inviteId = (Array.isArray(prepared) ? prepared[0] : prepared).invite_id;
    await must(service.from('participant_account_invites').update({
      auth_user_id: null,
      requires_password_setup: true,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }).eq('id', inviteId), `null auth ${authEmail}`);
    await must(service.auth.admin.updateUserById(authUserId, {
      user_metadata: { participant_invite_id: inviteId },
    }), `metadata ${authEmail}`);
    const guest = await clientFor(authEmail);
    await must(guest.rpc('upsert_customer_profile', {
      p_user_id: authUserId,
      p_full_name: identity.label ?? identity.contact.full_name ?? 'Pessoa',
      p_cpf: identity.cpf,
      p_birth_date: '1988-03-15',
      p_gender: 'female',
      p_phone: '11988887777',
      p_city: 'Itapiranga',
    }), `upsert ${authEmail}`);
    const claimed = await must(guest.rpc('claim_registration_contact_account_invite', {
      p_invite_id: inviteId,
    }), `claim ${authEmail}`);
    return { authUserId, inviteId, claimed, guest };
  }

  const admin = await makeAdmin('owner');
  const importBatch = await must(service.from('import_batches').insert({
    import_type: 'current_event_registrations',
    event_id: event.id,
    organization_id: org.id,
    imported_by: admin.userId,
    file_name: `canonical-own-${suffix}.csv`,
    total_rows: 4,
    status: 'processing',
    payment_mode_original: 'confirm_all',
  }).select('id').single(), 'import batch');

  await test('migration 20261106 esta aplicada no banco local', async () => {
    const skip = await service.rpc('materialize_intended_ticket_owners_for_contact', {
      p_contact_id: '00000000-0000-4000-8000-000000000001',
      p_user_id: '00000000-0000-4000-8000-000000000002',
    });
    assert.equal(skip.error, null, skip.error?.message);
    assert.equal(skip.data, 0);
    const preview = await admin.client.rpc('preview_intended_ticket_owner_materialization');
    assert.equal(preview.error, null, preview.error?.message);
  });

  await test('2. claim real: intended+owner null materializa uma vez', async () => {
    const email = `ana-like-${suffix}@qa.local`;
    const identity = await createPendingIdentity({
      label: 'Cadastro X Ana Like',
      email,
      cpf: generateValidCpf(),
      buyerType: 'imported_holder',
    });
    assert.equal(identity.contact.user_id, null);
    assert.equal(identity.ticket.owner_user_id, null);
    assert.equal(identity.ticket.intended_owner_contact_id, identity.contact.id);

    const { authUserId, inviteId, claimed } = await claimContact(admin, identity, email);
    assert.equal(String(claimed), String(identity.contact.id));

    const contactAfter = await must(service.from('registration_contacts').select('user_id').eq('id', identity.contact.id).single(), 'contact after claim');
    const ticketAfter = await must(service.from('tickets').select('owner_user_id,intended_owner_contact_id,status').eq('id', identity.ticket.id).single(), 'ticket after claim');
    const history = await historyFor(identity.ticket.id);

    assert.equal(contactAfter.user_id, authUserId);
    assert.equal(ticketAfter.owner_user_id, authUserId);
    assert.equal(history.length, 1, `esperado 1 historico, veio ${JSON.stringify(history)}`);
    assert.equal(history[0].operation, 'owner_assigned');
    assert.equal(history[0].previous_owner_user_id, null);
    assert.equal(history[0].new_owner_user_id, authUserId);
    assert.equal(history[0].reason_code, 'intended_owner_materialized');
    assert.doesNotMatch(JSON.stringify(history), /owner_transferred/);

    const retryClaim = await (await clientFor(email)).rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId });
    assert.equal(retryClaim.error, null, retryClaim.error?.message);
    const historyAfterRetry = await historyFor(identity.ticket.id);
    assert.equal(historyAfterRetry.length, 1, 'retry de claim nao pode duplicar historico');
  });

  await test('3. idempotencia: materialize de novo nao muda nada', async () => {
    const email = `idem-${suffix}@qa.local`;
    const identity = await createPendingIdentity({
      label: 'Idempotente X',
      email,
      cpf: generateValidCpf(),
      buyerType: 'imported_holder',
    });
    const { authUserId } = await claimContact(admin, identity, email);
    const before = await historyFor(identity.ticket.id);
    assert.equal(before.length, 1);
    const again = await must(service.rpc('materialize_intended_ticket_owners_for_contact', {
      p_contact_id: identity.contact.id,
      p_user_id: authUserId,
    }), 'materialize again');
    assert.equal(again, 0);
    const ticket = await must(service.from('tickets').select('owner_user_id').eq('id', identity.ticket.id).single(), 'ticket idem');
    assert.equal(ticket.owner_user_id, authUserId);
    assert.equal((await historyFor(identity.ticket.id)).length, 1);
  });

  await test('4. owner existente: titular cria conta e owner permanece', async () => {
    const douglas = await must(service.auth.admin.createUser({
      email: `douglas-own-${suffix}@qa.local`, password, email_confirm: true,
    }), 'douglas auth');
    const joaoEmail = `joao-holder-${suffix}@qa.local`;
    const identity = await createPendingIdentity({
      label: 'Joao Titular',
      email: joaoEmail,
      cpf: generateValidCpf(),
      buyerType: 'account',
      orderUserId: douglas.user.id,
      intendedSelf: true,
    });
    assert.equal(identity.ticket.owner_user_id, douglas.user.id);
    const before = await historyFor(identity.ticket.id);
    const { authUserId } = await claimContact(admin, identity, joaoEmail);
    const ticket = await must(service.from('tickets').select('owner_user_id').eq('id', identity.ticket.id).single(), 'kept owner');
    const contact = await must(service.from('registration_contacts').select('user_id').eq('id', identity.contact.id).single(), 'joao linked');
    const after = await historyFor(identity.ticket.id);
    assert.equal(contact.user_id, authUserId);
    assert.equal(ticket.owner_user_id, douglas.user.id);
    assert.equal(after.length, before.length);
    assert.equal(after.filter((row) => row.operation === 'owner_transferred').length, 0);
    assert.equal(after.filter((row) => row.reason_code === 'intended_owner_materialized').length, 0);
  });

  await test('5. compra autenticada de 3 ingressos: todos owner = Douglas', async () => {
    const email = `douglas-buy-${suffix}@qa.local`;
    const cpf = generateValidCpf();
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), 'buyer auth');
    await must(service.from('customer_profiles').upsert({
      user_id: created.user.id, full_name: 'Douglas Comprador', cpf, birth_date: '1990-01-01',
      phone: '11999990000', city: 'Sao Paulo', gender: 'male',
    }, { onConflict: 'user_id' }), 'buyer profile');
    const buyer = await clientFor(email);
    const checkout = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id,
      p_ticket_category_id: category.id,
      p_gender: 'male',
      p_quantity: 3,
      p_payment_method: 'courtesy',
      p_buyer_full_name: 'Douglas Comprador',
      p_buyer_cpf: cpf,
      p_buyer_birth_date: '1990-01-01',
      p_buyer_gender: 'male',
      p_buyer_phone: '11999990000',
      p_buyer_email: email,
      p_buyer_city: 'Sao Paulo',
      p_assign_first_to_buyer: true,
      p_limit_per_order: 10,
      p_client_request_id: `can-own-3-${suffix}`,
      p_items: [
        { pricing_gender: 'male', ownership_mode: 'self', ownership_status: 'assigned' },
        { pricing_gender: 'male', ownership_mode: 'named', ownership_status: 'unassigned', holder_full_name: 'Joao da Silva' },
        { pricing_gender: 'female', ownership_mode: 'named', ownership_status: 'unassigned', holder_full_name: 'Maria Souza' },
      ],
    });
    assert.equal(checkout.error, null, checkout.error?.message);
    const orderId = checkout.data[0].order_id;
    const items = await must(service.from('order_items').select('id,item_position,holder_full_name,registration_contact_id,intended_owner_contact_id').eq('order_id', orderId).order('item_position'), 'checkout items');
    const tickets = await must(service.from('tickets').select('id,owner_user_id,intended_owner_contact_id,order_item_id').eq('order_id', orderId), 'checkout tickets');
    assert.equal(items.length, 3);
    assert.equal(tickets.length, 3);
    assert.ok(tickets.every((ticket) => ticket.owner_user_id === created.user.id));
    assert.equal(items[0].holder_full_name, 'Douglas Comprador');
    assert.equal(items[1].holder_full_name, 'Joao da Silva');
    assert.equal(items[2].holder_full_name, 'Maria Souza');
    assert.equal(items[1].intended_owner_contact_id, null);
    assert.equal(items[2].intended_owner_contact_id, null);
    assert.ok(tickets.filter((ticket) => ticket.intended_owner_contact_id).every((ticket) => {
      const item = items.find((row) => row.id === ticket.order_item_id);
      return item?.registration_contact_id !== ticket.intended_owner_contact_id || item?.holder_full_name === 'Douglas Comprador';
    }), 'titular terceiro nao vira intended_owner');
    const thirdParty = tickets.filter((_, index) => items.find((item) => item.id === tickets[index]?.order_item_id)?.holder_full_name !== 'Douglas Comprador');
    for (const ticket of tickets) {
      const item = items.find((row) => row.id === ticket.order_item_id);
      if (item?.holder_full_name !== 'Douglas Comprador') {
        assert.equal(ticket.intended_owner_contact_id, null, `${item.holder_full_name} nao pode nascer pretendido`);
        assert.equal(item.registration_contact_id, null);
      }
    }
    assert.equal(thirdParty.length >= 0, true);
  });

  await test('6. importado sem conta: owner null+intended; claim materializa', async () => {
    const email = `import-ana-${suffix}@qa.local`;
    const identity = await createPendingIdentity({
      label: 'Ana Importada',
      email,
      cpf: generateValidCpf(),
      buyerType: 'imported_holder',
    });
    assert.equal(identity.order.buyer_type, 'imported_holder');
    assert.equal(identity.ticket.owner_user_id, null);
    assert.equal(identity.ticket.intended_owner_contact_id, identity.contact.id);
    const { authUserId } = await claimContact(admin, identity, email);
    const ticket = await must(service.from('tickets').select('owner_user_id').eq('id', identity.ticket.id).single(), 'imported after claim');
    assert.equal(ticket.owner_user_id, authUserId);
    const history = await historyFor(identity.ticket.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].reason_code, 'intended_owner_materialized');
  });

  await test('7. cancelado nao materializa nem pelo trigger nem pela RPC', async () => {
    const email = `cancel-${suffix}@qa.local`;
    const identity = await createPendingIdentity({
      label: 'Cancelado X',
      email,
      cpf: generateValidCpf(),
      buyerType: 'imported_holder',
      status: 'cancelled',
    });
    assert.equal(identity.ticket.status, 'cancelled');
    assert.equal(identity.ticket.owner_user_id, null);
    const { authUserId } = await claimContact(admin, identity, email);
    const afterClaim = await must(service.from('tickets').select('owner_user_id,status').eq('id', identity.ticket.id).single(), 'cancelled after claim');
    assert.equal(afterClaim.status, 'cancelled');
    assert.equal(afterClaim.owner_user_id, null);
    const rpcCount = await must(service.rpc('materialize_intended_ticket_owners_for_contact', {
      p_contact_id: identity.contact.id,
      p_user_id: authUserId,
    }), 'materialize cancelled');
    assert.equal(rpcCount, 0);
    assert.equal((await historyFor(identity.ticket.id)).length, 0);
  });
}
