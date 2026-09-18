// E2E controlado do ciclo de ownership (Pessoa sem Auth → ingresso pretendido →
// primeiro acesso materializa owner_user_id a partir de intended_owner → QR intacto).
// Roda contra o Supabase remoto do .env.local. Nao usa Jordan nem participante real.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

const OWNER_EMAIL = 'h.dogui@gmail.com';
const ORG_ID = '8d650d17-a190-417d-9ea6-a21e86fb9ac5';
const EVENT_SLUG = 'ownership-e2e-teste-admin';
const APP_ORIGIN = 'https://www.militrin.com.br';
const AUTH_OTP_TTL_SECONDS = 86_400;
const PERSON_NAME = 'E2E Ownership Controlado';
const FORBIDDEN_EMAILS = [
  'jordanbrand395@gmail.com',
  'h.dogui@gmail.com',
];
const FORBIDDEN_TICKETS = [
  '436380d8-3d70-4c49-b12e-aee22b59fdb4', // Jordan
  'af7c4988-0076-4d05-9e55-a164d5031b23', // Roberto cancelado
];
const FORBIDDEN_CONTACTS = [
  'c9b808e2-c7c1-4d5d-bef5-5e56d6b20cbe', // Jordan
  'c9f8e828-c7ef-4592-ac90-9b844e0f2dd5', // Leonardo
];

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
  }));
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

async function must(promise, label) {
  const result = await promise;
  if (result.error) throw new Error(`${label}: ${result.error.message ?? JSON.stringify(result.error)}`);
  return result.data;
}

function firstAccessInviteRedirect(inviteId) {
  const destination = `/primeiro-acesso?invite=${encodeURIComponent(inviteId)}`;
  return `${APP_ORIGIN}/auth/callback?next=${encodeURIComponent(destination)}`;
}

async function snapshotForbidden(service) {
  const tickets = await must(
    service.from('tickets').select('id,status,token,owner_user_id,intended_owner_contact_id').in('id', FORBIDDEN_TICKETS),
    'forbidden tickets',
  );
  const contacts = await must(
    service.from('registration_contacts').select('id,user_id,email,full_name,updated_at').in('id', FORBIDDEN_CONTACTS),
    'forbidden contacts',
  );
  return { tickets, contacts };
}

function assertForbiddenUnchanged(before, after) {
  assert.equal(after.tickets.length, before.tickets.length);
  assert.equal(after.contacts.length, before.contacts.length);
  for (const previous of before.tickets) {
    const next = after.tickets.find((row) => row.id === previous.id);
    assert.ok(next, `ingresso real ${previous.id} desapareceu`);
    assert.equal(next.status, previous.status);
    assert.equal(next.token, previous.token);
    assert.equal(next.owner_user_id, previous.owner_user_id);
    assert.equal(next.intended_owner_contact_id, previous.intended_owner_contact_id);
  }
  for (const previous of before.contacts) {
    const next = after.contacts.find((row) => row.id === previous.id);
    assert.ok(next, `cadastro real ${previous.id} desapareceu`);
    assert.equal(next.user_id, previous.user_id);
    assert.equal(next.email, previous.email);
  }
}

async function uniqueCpf(service) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const cpf = generateValidCpf();
    const { count, error } = await service
      .from('registration_contacts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', ORG_ID)
      .eq('cpf', cpf);
    if (error) throw new Error(`cpf probe: ${error.message}`);
    if (!count) return cpf;
  }
  throw new Error('nao foi possivel gerar CPF de teste unico');
}

function authedClient(url, anonKey, accessToken) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function sessionFromMagicLink(service, url, anonKey, email) {
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await service.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: `${APP_ORIGIN}/minha-conta/ingressos` },
  });
  if (error || !data?.properties?.hashed_token) {
    throw new Error(`generateLink magiclink ${email}: ${error?.message ?? 'missing hashed_token'}`);
  }
  const otp = await anon.auth.verifyOtp({
    token_hash: data.properties.hashed_token,
    type: 'email',
  });
  if (otp.error || !otp.data?.session?.access_token || !otp.data.user?.id) {
    throw new Error(`verifyOtp magiclink ${email}: ${otp.error?.message ?? 'no session'}`);
  }
  return {
    client: authedClient(url, anonKey, otp.data.session.access_token),
    userId: otp.data.user.id,
    accessToken: otp.data.session.access_token,
  };
}

async function sessionFromPassword(url, anonKey, email, password) {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error || !signed.data.session?.access_token || !signed.data.user?.id) {
    throw new Error(`signInWithPassword ${email}: ${signed.error?.message ?? 'no session'}`);
  }
  return {
    client,
    userId: signed.data.user.id,
    accessToken: signed.data.session.access_token,
  };
}

async function ensureTestEvent(service) {
  let event = (await must(
    service.from('events').select('id,name,slug,organization_id,is_active,kit_enabled').eq('slug', EVENT_SLUG).maybeSingle(),
    'event lookup',
  ));
  if (!event) {
    event = await must(service.from('events').insert({
      organization_id: ORG_ID,
      name: 'Ownership E2E teste admin',
      year: 2026,
      slug: EVENT_SLUG,
      is_active: false,
      registration_enabled: false,
      kit_enabled: false,
      min_age: 18,
      starts_at: '2026-11-21T12:00:00-03:00',
    }).select('id,name,slug,organization_id,is_active,kit_enabled').single(), 'create event');
  }
  assert.equal(event.organization_id, ORG_ID);
  if (event.kit_enabled) {
    await must(service.from('events').update({ kit_enabled: false }).eq('id', event.id), 'disable kit');
    event.kit_enabled = false;
  }

  let category = (await must(
    service.from('ticket_categories').select('id,name,is_active').eq('event_id', event.id).eq('slug', 'geral-ownership-e2e').maybeSingle(),
    'category lookup',
  ));
  if (!category) {
    category = await must(service.from('ticket_categories').insert({
      event_id: event.id,
      name: 'Geral',
      slug: 'geral-ownership-e2e',
      is_active: true,
      sort_order: 1,
    }).select('id,name,is_active').single(), 'create category');
  }

  let batch = (await must(
    service.from('registration_batches').select('id,name,is_active').eq('event_id', event.id).eq('name', 'Lote E2E ownership').maybeSingle(),
    'batch lookup',
  ));
  if (!batch) {
    batch = await must(service.from('registration_batches').insert({
      event_id: event.id,
      name: 'Lote E2E ownership',
      sequence_number: 1,
      male_price: 0,
      female_price: 0,
      max_confirmed_registrations: 50,
      is_active: true,
      flat_price_confirmed: true,
    }).select('id,name,is_active').single(), 'create batch');
  }

  const price = await must(
    service.from('registration_batch_prices').select('id').eq('batch_id', batch.id).eq('ticket_category_id', category.id).maybeSingle(),
    'price lookup',
  );
  if (!price) {
    await must(service.from('registration_batch_prices').insert({
      batch_id: batch.id,
      ticket_category_id: category.id,
      male_price: 0,
      female_price: 0,
    }), 'create price');
  }

  return { event, category, batch };
}

async function ticketSnapshot(service, ticketId) {
  return must(
    service.from('tickets').select(
      'id,status,token,issued_at,owner_user_id,intended_owner_contact_id,participant_id,order_id,order_item_id,event_id',
    ).eq('id', ticketId).single(),
    `ticket ${ticketId}`,
  );
}

async function portalTickets(client, userId) {
  return must(
    client.from('tickets').select('id,status,token,issued_at,owner_user_id,order_item_id').eq('owner_user_id', userId).neq('status', 'cancelled'),
    'minha conta tickets',
  );
}

test('ciclo ownership E2E: Pessoa sem Auth, primeiro acesso materializa owner e Minha Conta, depois cancela so o teste', async () => {
  const env = parseEnv(await readFile(new URL('../.env.local', import.meta.url), 'utf8'));
  const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  assert.ok(url && anonKey && serviceKey, 'faltam credenciais no .env.local');

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const stamp = Date.now();
  const email = `h.dogui+own-e2e-${stamp}@gmail.com`;
  const password = `OwnE2e-${stamp}!aA`;
  assert.ok(!FORBIDDEN_EMAILS.includes(email));
  assert.match(email, /^h\.dogui\+own-e2e-\d+@gmail\.com$/);

  const beforeForbidden = await snapshotForbidden(service);
  const fixture = await ensureTestEvent(service);
  const owner = await sessionFromMagicLink(service, url, anonKey, OWNER_EMAIL);
  assert.equal(owner.userId, 'e8f5777b-3ed1-409d-b3f1-71724be5a09e');

  const leftoverContacts = await must(
    service.from('registration_contacts').select('id').eq('organization_id', ORG_ID).eq('full_name', PERSON_NAME),
    'leftover contacts',
  );
  if (leftoverContacts.length) {
    const leftoverTickets = await must(
      service.from('tickets').select('id,status').eq('event_id', fixture.event.id).eq('status', 'active').in('intended_owner_contact_id', leftoverContacts.map((row) => row.id)),
      'leftover tickets',
    );
    for (const ticket of leftoverTickets) {
      await must(owner.client.rpc('owner_cancel_ticket', {
        p_ticket_id: ticket.id,
        p_reason_code: 'system_test',
        p_reason_text: 'E2E ownership controlado — limpeza de residual da tentativa anterior. Nao substituir.',
        p_replacement_required: false,
      }), `cancel leftover ${ticket.id}`);
    }
  }

  let contactId = null;
  let ticketId = null;
  let authUserId = null;
  let inviteId = null;
  const report = {
    at: new Date().toISOString(),
    email,
    password,
    eventId: fixture.event.id,
    eventSlug: EVENT_SLUG,
  };

  try {
    const cpf = await uniqueCpf(service);
    contactId = await must(owner.client.rpc('create_registration_contact', {
      p_organization_id: ORG_ID,
      p_full_name: PERSON_NAME,
      p_cpf: cpf,
      p_birth_date: '1990-01-15',
      p_gender: 'male',
      p_phone: '47988880000',
      p_email: email,
      p_city: 'Itapiranga',
    }), 'create_registration_contact');
    assert.match(String(contactId), /^[0-9a-f-]{36}$/i);

    const contact = await must(
      service.from('registration_contacts').select('id,full_name,email,user_id,cpf,organization_id').eq('id', contactId).single(),
      'contact after create',
    );
    assert.equal(contact.full_name, PERSON_NAME);
    assert.equal(String(contact.email).toLowerCase(), email);
    assert.equal(contact.user_id, null, 'Pessoa de teste nao pode nascer com Auth vinculada');
    assert.equal(contact.organization_id, ORG_ID);
    assert.doesNotMatch(contact.full_name, /jordan|leonardo|roberto/i);

    const issued = await must(owner.client.rpc('issue_manual_ticket_batch', {
      p_registration_contact_id: contactId,
      p_event_id: fixture.event.id,
      p_ticket_category_id: fixture.category.id,
      p_batch_id: fixture.batch.id,
      p_quantity: 1,
      p_pricing_gender: 'male',
      p_shirt_type: null,
      p_shirt_size: null,
      p_payment_method: 'other',
      p_notes: 'E2E ownership controlado — cancelar apos validacao, nao substituir.',
      p_assign_holder: true,
    }), 'issue_manual_ticket_batch');
    ticketId = issued?.[0]?.ticket_id ?? issued?.[0]?.ticketId ?? null;
    if (!ticketId && Array.isArray(issued) === false && issued?.ticket_id) ticketId = issued.ticket_id;
    assert.match(String(ticketId), /^[0-9a-f-]{36}$/i, `emissao nao devolveu ticket_id: ${JSON.stringify(issued)}`);
    assert.ok(!FORBIDDEN_TICKETS.includes(ticketId));

    const afterIssue = await ticketSnapshot(service, ticketId);
    assert.equal(afterIssue.status, 'active');
    assert.equal(afterIssue.intended_owner_contact_id, contactId);
    assert.equal(afterIssue.owner_user_id, null, 'owner nao pode materializar antes do primeiro acesso');
    assert.ok(afterIssue.token, 'QR/token precisa existir na emissao');
    const qrBefore = afterIssue.token;
    const issuedAt = afterIssue.issued_at;
    const orderItemId = afterIssue.order_item_id;

    const { count: ticketsForItem } = await service.from('tickets').select('id', { count: 'exact', head: true }).eq('order_item_id', orderItemId);
    assert.equal(ticketsForItem, 1);

    const eligibility = await must(
      owner.client.rpc('check_registration_contact_account_invite_eligibility', { p_registration_contact_id: contactId }),
      'invite eligibility',
    );
    const eligibilityRow = Array.isArray(eligibility) ? eligibility[0] : eligibility;
    assert.equal(eligibilityRow?.eligible, true, eligibilityRow?.reason_message ?? 'cadastro nao elegivel');

    const prepared = await must(
      owner.client.rpc('prepare_registration_contact_account_invite', { p_registration_contact_id: contactId }),
      'prepare invite',
    );
    const preparedRow = Array.isArray(prepared) ? prepared[0] : prepared;
    inviteId = preparedRow?.invite_id;
    assert.ok(inviteId);
    assert.equal(String(preparedRow.email).toLowerCase(), email);

    await must(
      service.from('participant_account_invites').update({
        requires_password_setup: true,
        updated_at: new Date().toISOString(),
      }).eq('id', inviteId).is('password_setup_completed_at', null),
      'require password',
    );

    const invited = await service.auth.admin.inviteUserByEmail(email, {
      redirectTo: firstAccessInviteRedirect(inviteId),
      data: { participant_invite_id: inviteId, full_name: PERSON_NAME, ownership_e2e: true },
    });
    assert.equal(invited.error, null, invited.error?.message ?? 'inviteUserByEmail falhou');
    authUserId = invited.data?.user?.id ?? null;
    assert.ok(authUserId);

    const sentAt = new Date();
    await must(service.from('participant_account_invites').update({
      auth_user_id: authUserId,
      auth_email_sent_at: sentAt.toISOString(),
      auth_link_expires_at: new Date(sentAt.getTime() + AUTH_OTP_TTL_SECONDS * 1000).toISOString(),
      updated_at: sentAt.toISOString(),
    }).eq('id', inviteId), 'stamp invite auth');
    await must(service.from('customer_profiles').upsert({
      user_id: authUserId,
      account_status: 'pending_activation',
      must_change_password: true,
      must_complete_profile: true,
    }, { onConflict: 'user_id' }), 'mark pending activation');

    const stillPending = await ticketSnapshot(service, ticketId);
    assert.equal(stillPending.owner_user_id, null, 'envio do convite nao pode materializar owner');
    assert.equal(stillPending.token, qrBefore);

    const confirmed = await service.auth.admin.updateUserById(authUserId, {
      password,
      email_confirm: true,
    });
    assert.equal(confirmed.error, null, confirmed.error?.message ?? 'falha ao confirmar Auth de teste');
    const guest = await sessionFromPassword(url, anonKey, email, password);
    assert.equal(guest.userId, authUserId);

    await must(service.from('participant_account_invites').update({
      password_setup_completed_at: new Date().toISOString(),
      auth_confirmed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', inviteId).eq('auth_user_id', authUserId), 'stamp password completed');

    await must(guest.client.rpc('upsert_customer_profile', {
      p_user_id: authUserId,
      p_full_name: PERSON_NAME,
      p_cpf: cpf,
      p_birth_date: '1990-01-15',
      p_gender: 'male',
      p_phone: '47988880000',
      p_city: 'Itapiranga',
    }), 'upsert_customer_profile');

    const claimed = await must(
      guest.client.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId }),
      'claim_registration_contact_account_invite',
    );
    assert.equal(String(claimed), String(contactId));
    await must(guest.client.rpc('ensure_registration_contact_for_user', { p_user_id: authUserId }), 'ensure_registration_contact_for_user');
    await guest.client.from('customer_profiles').update({
      must_change_password: false,
      must_complete_profile: false,
      account_status: 'active',
      activation_completed_at: new Date().toISOString(),
    }).eq('user_id', authUserId);

    const afterClaim = await ticketSnapshot(service, ticketId);
    assert.equal(afterClaim.id, ticketId, 'ingresso foi reemitido (id mudou)');
    assert.equal(afterClaim.token, qrBefore, 'QR/token mudou apos o primeiro acesso');
    assert.equal(afterClaim.issued_at, issuedAt);
    assert.equal(afterClaim.status, 'active');
    assert.equal(afterClaim.owner_user_id, authUserId, 'primeiro acesso materializa owner a partir do intended');
    assert.equal(afterClaim.intended_owner_contact_id, contactId);
    const { count: ticketsAfterClaim } = await service.from('tickets').select('id', { count: 'exact', head: true }).eq('order_item_id', orderItemId);
    assert.equal(ticketsAfterClaim, 1, 'houve reemissao: mais de um ticket no mesmo item');

    const linked = await must(
      service.from('registration_contacts').select('user_id').eq('id', contactId).single(),
      'contact after claim',
    );
    assert.equal(linked.user_id, authUserId);

    const history = await must(
      service.from('ticket_owner_history').select('id,operation,previous_owner_user_id,new_owner_user_id,ticket_id').eq('ticket_id', ticketId),
      'owner history',
    );
    assert.equal(history.filter((row) => row.operation === 'owner_assigned').length, 1, 'materializacao inicial grava owner_assigned');
    assert.equal(history.filter((row) => row.operation === 'owner_transferred').length, 0, 'nao e transferencia');
    const assigned = history.find((row) => row.operation === 'owner_assigned');
    assert.equal(assigned.previous_owner_user_id, null);
    assert.equal(assigned.new_owner_user_id, authUserId);

    const mine = await portalTickets(guest.client, authUserId);
    assert.equal(mine.some((row) => row.id === ticketId), true, 'depois da materializacao o ingresso aparece na Minha Conta');

    const keep = process.env.OWNERSHIP_E2E_KEEP === '1';
    if (!keep) {
      const cancelled = await must(owner.client.rpc('owner_cancel_ticket', {
        p_ticket_id: ticketId,
        p_reason_code: 'system_test',
        p_reason_text: 'E2E ownership controlado — limpeza apos validacao. Nao substituir.',
        p_replacement_required: false,
      }), 'owner_cancel_ticket');
      assert.equal(cancelled?.success, true);
      assert.equal(cancelled?.status, 'cancelled');

      const afterCancel = await ticketSnapshot(service, ticketId);
      assert.equal(afterCancel.status, 'cancelled');
      assert.equal(afterCancel.token, qrBefore, 'cancelamento nao pode rotacionar o QR');
      assert.equal(afterCancel.owner_user_id, authUserId, 'cancelamento preserva owner materializado');
      const historyAfter = await must(
        service.from('ticket_owner_history').select('id').eq('ticket_id', ticketId),
        'history after cancel',
      );
      assert.ok(historyAfter.length >= history.length, 'limpeza apagou historico de ownership');

      const mineAfter = await portalTickets(guest.client, authUserId);
      assert.equal(mineAfter.some((row) => row.id === ticketId), false, 'ingresso cancelado ainda aparece na Minha Conta');
      report.cancelled = true;
    } else {
      report.cancelled = false;
      report.keepReason = 'OWNERSHIP_E2E_KEEP=1; cancelar depois da conferencia visual na Minha Conta';
    }

    const afterForbidden = await snapshotForbidden(service);
    assertForbiddenUnchanged(beforeForbidden, afterForbidden);

    Object.assign(report, {
      ok: true,
      contactId,
      ticketId,
      authUserId,
      inviteId,
      qrToken: qrBefore,
      cadastroUrl: `${APP_ORIGIN}/cadastros/${contactId}`,
      ticketUrl: `${APP_ORIGIN}/ingressos/${ticketId}`,
      minhaContaUrl: `${APP_ORIGIN}/minha-conta/ingressos`,
      loginHint: 'Use o plus-alias do Gmail (cai na caixa de h.dogui@gmail.com) e a senha deste relatorio.',
    });
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
    if (ticketId && owner?.client) {
      try {
        await owner.client.rpc('owner_cancel_ticket', {
          p_ticket_id: ticketId,
          p_reason_code: 'system_test',
          p_reason_text: 'E2E ownership controlado — rollback apos falha. Nao substituir.',
          p_replacement_required: false,
        });
      } catch {
        // rollback best-effort; o relatorio em tmp-ownership-e2e-state.json identifica o ticket
      }
    }
    throw error;
  } finally {
    await writeFile(new URL('../tmp-ownership-e2e-state.json', import.meta.url), JSON.stringify(report, null, 2), 'utf8');
    console.info(JSON.stringify({
      ok: report.ok !== false,
      email,
      password,
      contactId,
      ticketId,
      cadastroUrl: report.cadastroUrl ?? null,
      ticketUrl: report.ticketUrl ?? null,
      minhaContaUrl: `${APP_ORIGIN}/minha-conta/ingressos`,
    }, null, 2));
  }
});
