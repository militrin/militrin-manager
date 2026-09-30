import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const API = 'http://127.0.0.1:15421';
const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const MIGRATION = new URL('../supabase/migrations/20261117000000_restore_same_name_holder_links.sql', import.meta.url);
const PASSWORD = 'Fase8C-local-only-123!';

const CANDIDATES = [
  {
    code: '1964',
    ticketId: '8a994cbb-ef79-452a-8762-625c440c7411',
    itemId: '8f84b813-d43a-40d2-a1a4-0cdeb65038c8',
    holder: 'Daniel Stein Sutel',
    ownerId: 'd8277988-edf1-49b9-8289-47d280676066',
    participantId: 'e87416dd-aff5-42cf-8724-ad12d4cbe8f0',
    contactId: '90784f42-3bd1-4941-a42e-8593abffefc7',
    status: 'used',
    usedAt: '2026-09-20T12:00:00Z',
  },
  {
    code: '2025',
    ticketId: 'b58defbb-df88-4ef0-9126-7be1dbeddf84',
    itemId: 'acf1d119-17c6-47cb-99cc-55f52273620a',
    holder: 'Maria Julia Dalavechia',
    ownerId: 'a3c79b1d-91dc-438a-af7d-9028a8ddafa0',
    participantId: 'bf7eb060-28c1-40d0-a753-a72784d36d39',
    contactId: '1c75c05c-d7fe-47eb-8946-def632a3b230',
    status: 'active',
    usedAt: null,
  },
  {
    code: '2030',
    ticketId: 'ce8f9a3a-7bfd-49c0-8a95-003299b870af',
    itemId: 'f2fd377a-33f6-4dc7-bde7-0210d80a7c1d',
    holder: 'Paulo Henrike da Rosa',
    ownerId: '1ca5ed2e-a77a-4c77-b6d3-d9ed2cf33c35',
    participantId: 'b174c706-aed1-4af0-b4e9-8c80129aa3a3',
    contactId: '03048428-bd6d-4871-9182-4f0efc73d429',
    status: 'active',
    usedAt: null,
  },
  {
    code: '2095',
    ticketId: '750dd73b-3d0f-4baf-b410-e820bad5a0c8',
    itemId: 'bd54a4a6-141a-4cb7-bd3f-3c36e513476c',
    holder: 'Bruna Sell',
    ownerId: 'c5db9d00-a358-4bff-a6ac-abaec9611817',
    participantId: 'a0d04017-a68c-46fc-8686-ef75dc14e0f1',
    contactId: 'e90fa59c-0fbb-4290-a3f4-abce82d20eb8',
    status: 'used',
    usedAt: '2026-09-28T18:00:00Z',
  },
];

const SENTINEL = {
  ticketId: 'a811f268-8fde-4cf2-85d9-27196a6fa9cc',
  itemId: 'aaaaaaaa-1111-2222-3333-444444444444',
  holder: 'Alessandro Sentinel',
  ownerId: 'bbbbbbbb-1111-2222-3333-444444444444',
  participantId: 'cccccccc-1111-2222-3333-444444444444',
  contactId: 'dddddddd-1111-2222-3333-444444444444',
};

function psql(sql, { allowError = false } = {}) {
  try {
    return execFileSync(
      'docker',
      ['exec', '-i', 'supabase_db_militrin-manager', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
      { input: sql, encoding: 'utf8' },
    );
  } catch (error) {
    const message = `${error.stderr || ''}\n${error.stdout || ''}\n${error.message || ''}`;
    if (allowError) return { ok: false, message };
    throw error;
  }
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function ping() {
  try {
    const response = await fetch(`${API}/auth/v1/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureAuthUser(service, id, email) {
  const existing = await service.auth.admin.getUserById(id);
  if (existing.data?.user?.id === id) return id;
  const created = await service.auth.admin.createUser({
    id, email, password: PASSWORD, email_confirm: true,
  });
  if (created.error) {
    const byEmail = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = (byEmail.data?.users ?? []).find((user) => user.email === email);
    if (found?.id === id) return id;
    throw new Error(`createUser ${email}: ${created.error.message}`);
  }
  return created.data.user.id;
}

function applyExactMigration() {
  return psql(readFileSync(MIGRATION, 'utf8'));
}

function snapshotSql(ids) {
  return `
    select t.id::text as ticket_id,
           t.participant_id::text as ticket_pid,
           t.owner_user_id::text as owner_user_id,
           t.status,
           coalesce(t.used_at::text, '') as used_at,
           coalesce(t.intended_owner_contact_id::text, '') as intended_owner,
           oi.participant_id::text as item_pid,
           oi.registration_contact_id::text as contact_id,
           oi.holder_full_name,
           o.participant_id::text as order_pid
    from public.tickets t
    join public.order_items oi on oi.id = t.order_item_id
    join public.orders o on o.id = t.order_id
    where t.id in (${ids.map(quote).join(',')})
    order by t.id;
  `;
}

if (!await ping()) {
  test('Fase 8C local: supabase 15421 ausente', () => {
    assert.fail('Supabase local em 127.0.0.1:15421 precisa estar no ar para este gate.');
  });
} else {
  const service = createClient(API, SERVICE, options);

  async function seedEligibleState({ divergeHolderId = null, extraConflict = false } = {}) {
    const suffix = `${Date.now()}`;
    const org = await service.from('organizations').insert({
      name: 'Fase 8C Local', slug: `fase8c-${suffix}`, status: 'active',
    }).select('id').single();
    assert.equal(org.error, null, org.error?.message);
    const event = await service.from('events').insert({
      organization_id: org.data.id, name: 'Evento 8C', year: 2032, slug: `evento-8c-${suffix}`,
      is_active: true, registration_enabled: true, starts_at: '2032-10-10T12:00:00Z', min_age: 0,
    }).select('id').single();
    assert.equal(event.error, null, event.error?.message);
    const category = await service.from('ticket_categories').insert({
      event_id: event.data.id, name: 'Geral', slug: `geral-8c-${suffix}`, is_active: true,
    }).select('id').single();
    const batch = await service.from('registration_batches').insert({
      event_id: event.data.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100,
      max_confirmed_registrations: 100, is_active: true,
    }).select('id').single();
    assert.equal(category.error, null, category.error?.message);
    assert.equal(batch.error, null, batch.error?.message);

    const allPeople = [...CANDIDATES, SENTINEL];
    for (const person of allPeople) {
      await ensureAuthUser(service, person.ownerId, `fase8c-${person.ticketId.slice(0, 8)}-${suffix}@qa.local`);
    }

    const ticketIds = allPeople.map((row) => row.ticketId);
    const itemIds = allPeople.map((row) => row.itemId);
    const participantIds = allPeople.map((row) => row.participantId);
    const contactIds = allPeople.map((row) => row.contactId);

    psql(`
      delete from public.ticket_owner_history where ticket_id in (${ticketIds.map(quote).join(',')});
      delete from public.ticket_holder_history where ticket_id in (${ticketIds.map(quote).join(',')});
      delete from public.audit_logs where entity_id in (${ticketIds.map(quote).join(',')});
      delete from public.tickets where id in (${ticketIds.map(quote).join(',')});
      delete from public.order_items where id in (${itemIds.map(quote).join(',')});
      delete from public.orders where participant_id in (${participantIds.map(quote).join(',')});
      delete from public.participants where id in (${participantIds.map(quote).join(',')});
      delete from public.registration_contacts where id in (${contactIds.map(quote).join(',')});
    `);

    const values = allPeople.map((person, index) => {
      const holder = person.ticketId === divergeHolderId ? 'NOME DIVERGENTE 8C' : person.holder;
      const usedAt = person.usedAt ? quote(person.usedAt) : 'null';
      const status = person.status ?? 'active';
      return `
        insert into public.registration_contacts (
          id, organization_id, full_name, email, phone, cpf, birth_date, created_by
        ) values (
          ${quote(person.contactId)}, ${quote(org.data.id)}, ${quote(person.holder)},
          ${quote(`fase8c-${person.ticketId.slice(0, 8)}-${suffix}@qa.local`)}, '49999990000', ${quote(`${String(10000000000 + index)}${suffix}`.slice(0, 11))},
          '1990-01-01', ${quote(person.ownerId)}
        );

        insert into public.participants (
          id, full_name, registration_status, reservation_status, organization_id, event_id, registration_contact_id, user_id
        ) values (
          ${quote(person.participantId)}, ${quote(person.holder)}, 'confirmed', 'confirmed',
          ${quote(org.data.id)}, ${quote(event.data.id)}, ${quote(person.contactId)}, ${quote(person.ownerId)}
        );

        insert into public.orders (
          id, user_id, participant_id, event_id, order_number, status, base_amount, final_amount, organization_id, buyer_type
        ) values (
          gen_random_uuid(), ${quote(person.ownerId)}, ${quote(person.participantId)}, ${quote(event.data.id)},
          ${quote(`8C-${person.ticketId.slice(0, 8)}-${suffix}`)}, 'confirmed', 100, 100, ${quote(org.data.id)}, 'account'
        );

        insert into public.order_items (
          id, order_id, event_id, participant_id, registration_contact_id, ticket_category_id, batch_id,
          quantity, unit_price, final_amount, status, ownership_status, holder_full_name, item_kind, item_position
        )
        select ${quote(person.itemId)}, o.id, ${quote(event.data.id)}, null, null,
               ${quote(category.data.id)}, ${quote(batch.data.id)}, 1, 100, 100, 'confirmed', 'assigned',
               ${quote(holder)}, 'ticket', 1
        from public.orders o
        where o.order_number = ${quote(`8C-${person.ticketId.slice(0, 8)}-${suffix}`)};

        insert into public.tickets (
          id, order_id, participant_id, event_id, status, used_at, order_item_id, organization_id, owner_user_id, intended_owner_contact_id
        )
        select ${quote(person.ticketId)}, o.id, null, ${quote(event.data.id)}, ${quote(status)}, ${usedAt},
               ${quote(person.itemId)}, ${quote(org.data.id)}, ${quote(person.ownerId)}, null
        from public.orders o
        where o.order_number = ${quote(`8C-${person.ticketId.slice(0, 8)}-${suffix}`)};
      `;
    }).join('\n');

    psql(values);

    if (extraConflict) {
      const extra = CANDIDATES[3];
      psql(`
        insert into public.orders (
          id, user_id, participant_id, event_id, order_number, status, base_amount, final_amount, organization_id, buyer_type
        ) values (
          gen_random_uuid(), ${quote(extra.ownerId)}, ${quote(extra.participantId)}, ${quote(event.data.id)},
          ${quote(`8C-conflict-${suffix}`)}, 'confirmed', 100, 100, ${quote(org.data.id)}, 'account'
        );
        insert into public.order_items (
          order_id, event_id, participant_id, registration_contact_id, ticket_category_id, batch_id,
          quantity, unit_price, final_amount, status, ownership_status, holder_full_name, item_kind, item_position
        )
        select o.id, ${quote(event.data.id)}, ${quote(extra.participantId)}, ${quote(extra.contactId)},
               ${quote(category.data.id)}, ${quote(batch.data.id)}, 1, 100, 100, 'confirmed', 'assigned',
               ${quote(extra.holder)}, 'ticket', 1
        from public.orders o where o.order_number = ${quote(`8C-conflict-${suffix}`)};
        insert into public.tickets (
          order_id, participant_id, event_id, status, order_item_id, organization_id, owner_user_id
        )
        select o.id, ${quote(extra.participantId)}, ${quote(event.data.id)}, 'active', oi.id,
               ${quote(org.data.id)}, ${quote(extra.ownerId)}
        from public.orders o
        join public.order_items oi on oi.order_id = o.id
        where o.order_number = ${quote(`8C-conflict-${suffix}`)};
      `);
    }

    return { eventId: event.data.id, orgId: org.data.id };
  }

  function readState(ids) {
    const raw = execFileSync(
      'docker',
      ['exec', '-i', 'supabase_db_militrin-manager', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-F', '|', '-c', snapshotSql(ids)],
      { encoding: 'utf8' },
    ).trim();
    return raw.split(/\r?\n/).filter(Boolean).map((line) => {
      const [ticketId, ticketPid, owner, status, usedAt, intended, itemPid, contactId, holder, orderPid] = line.split('|');
      return { ticketId, ticketPid, owner, status, usedAt, intended, itemPid, contactId, holder, orderPid };
    });
  }

  await test('Fase 8C local: migration exata restaura 4/4 e nao toca 2052', async () => {
    await seedEligibleState();
    applyExactMigration();
    const restored = readState(CANDIDATES.map((row) => row.ticketId));
    assert.equal(restored.length, 4);
    for (const person of CANDIDATES) {
      const row = restored.find((item) => item.ticketId === person.ticketId);
      assert.equal(row.ticketPid, person.participantId);
      assert.equal(row.itemPid, person.participantId);
      assert.equal(row.contactId, person.contactId);
      assert.equal(row.holder, person.holder);
      assert.equal(row.owner, person.ownerId);
      assert.equal(row.status, person.status);
      assert.equal(row.intended, '');
      assert.equal(row.orderPid, person.participantId);
      if (person.usedAt) assert.match(row.usedAt, /2026-09-/);
      else assert.equal(row.usedAt, '');
    }
    const sentinel = readState([SENTINEL.ticketId])[0];
    assert.equal(sentinel.ticketPid, '');
    assert.equal(sentinel.itemPid, '');
    assert.equal(sentinel.contactId, '');
    assert.equal(sentinel.holder, SENTINEL.holder);

    const audits = execFileSync(
      'docker',
      ['exec', 'supabase_db_militrin-manager', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c',
        `select count(*) from public.audit_logs
         where action='holder_links_restored'
           and details->>'source'='same_name_holder_noop_repair'
           and entity_id in (${CANDIDATES.map((row) => quote(row.ticketId)).join(',')})`],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(audits, '4');
    const holderChanged = execFileSync(
      'docker',
      ['exec', 'supabase_db_militrin-manager', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c',
        `select count(*) from public.audit_logs
         where action='holder_changed'
           and entity_id in (${CANDIDATES.map((row) => quote(row.ticketId)).join(',')})`],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(holderChanged, '0');
  });

  await test('Fase 8C atomicidade: 1 holder divergente aborta e nenhum dos 4 restaura', async () => {
    await seedEligibleState({ divergeHolderId: CANDIDATES[3].ticketId });
    const before = readState(CANDIDATES.map((row) => row.ticketId));
    for (const row of before) {
      assert.equal(row.ticketPid, '');
      assert.equal(row.itemPid, '');
      assert.equal(row.contactId, '');
    }
    const failed = psql(readFileSync(MIGRATION, 'utf8'), { allowError: true });
    assert.match(String(failed.message), /STOP 8C: holder textual divergente/);
    const after = readState(CANDIDATES.map((row) => row.ticketId));
    for (const row of after) {
      assert.equal(row.ticketPid, '');
      assert.equal(row.itemPid, '');
      assert.equal(row.contactId, '');
    }
    const audits = execFileSync(
      'docker',
      ['exec', 'supabase_db_militrin-manager', 'psql', '-U', 'postgres', '-d', 'postgres', '-At', '-c',
        `select count(*) from public.audit_logs
         where action='holder_links_restored'
           and details->>'source'='same_name_holder_noop_repair'
           and entity_id in (${CANDIDATES.map((row) => quote(row.ticketId)).join(',')})`],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(audits, '0');
  });

  await test('Fase 8C atomicidade: conflito de unicidade aborta 0/4', async () => {
    await seedEligibleState({ extraConflict: true });
    const failed = psql(readFileSync(MIGRATION, 'utf8'), { allowError: true });
    assert.match(String(failed.message), /STOP 8C: conflito de unicidade/);
    const after = readState(CANDIDATES.map((row) => row.ticketId));
    for (const row of after) {
      assert.equal(row.ticketPid, '');
      assert.equal(row.itemPid, '');
      assert.equal(row.contactId, '');
    }
  });
}
