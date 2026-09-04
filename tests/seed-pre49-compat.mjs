// Seeds equivalent "pre-migration 49" rows on the local DB while 48 is still
// the latest applied version. Run once before `npx supabase migration up --local`.
import { writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

const url = 'http://127.0.0.1:54321';
const serviceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

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

async function must(promise, label) {
  const result = await promise;
  if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.data;
}

const suffix = `${Date.now()}`;
const password = 'Pre49-compat-local-123!';
const ownerEmail = `pre49-owner-${suffix}@qa.local`;
const created = await must(service.auth.admin.createUser({ email: ownerEmail, password, email_confirm: true }), 'auth user');
const ownerUserId = created.user.id;

const org = await must(service.from('organizations').insert({
  name: 'Pre49 Compat Org', slug: `pre49-compat-${suffix}`, status: 'active',
}).select('id').single(), 'org');
const event = await must(service.from('events').insert({
  organization_id: org.id, name: 'Evento Pre49', year: 2026, slug: `pre49-evt-${suffix}`,
  is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
}).select('id').single(), 'event');
const category = await must(service.from('ticket_categories').insert({
  event_id: event.id, name: 'Geral', slug: `pre49-geral-${suffix}`, is_active: true,
}).select('id').single(), 'category');
const batch = await must(service.from('registration_batches').insert({
  event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100,
  max_confirmed_registrations: 100, is_active: true,
}).select('id').single(), 'batch');

const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
await must(service.from('organization_members').insert({
  organization_id: org.id, user_id: ownerUserId, is_owner: true, is_active: true, role_id: ownerRole.id,
}), 'org member');

const ownedCpf = generateValidCpf();
const ownedContact = await must(service.from('registration_contacts').insert({
  organization_id: org.id, full_name: 'Titular Antigo Com Conta', cpf: ownedCpf,
  birth_date: '1990-01-15', gender: 'male', phone: '11999990001', email: ownerEmail, city: 'Itapiranga',
  user_id: ownerUserId,
}).select('id').single(), 'owned contact');
const ownedParticipant = await must(service.from('participants').insert({
  organization_id: org.id, event_id: event.id, registration_contact_id: ownedContact.id, user_id: ownerUserId,
  full_name: 'Titular Antigo Com Conta', cpf: ownedCpf, email: ownerEmail, birth_date: '1990-01-15',
  gender: 'male', phone: '11999990001', city: 'Itapiranga', registration_status: 'confirmed',
}).select('id').single(), 'owned participant');
const ownedOrder = await must(service.from('orders').insert({
  organization_id: org.id, event_id: event.id, participant_id: ownedParticipant.id,
  order_number: `PRE49-OWN-${suffix}`, status: 'confirmed', base_amount: 100, final_amount: 100,
  buyer_type: 'administrative',
}).select('id').single(), 'owned order');
const ownedItem = await must(service.from('order_items').insert({
  order_id: ownedOrder.id, event_id: event.id, participant_id: ownedParticipant.id,
  registration_contact_id: ownedContact.id, item_kind: 'ticket', ticket_category_id: category.id,
  batch_id: batch.id, quantity: 1, unit_price: 100, discount_amount: 0, final_amount: 100,
  status: 'confirmed', ownership_status: 'assigned', holder_full_name: 'Titular Antigo Com Conta',
}).select('id').single(), 'owned item');
const ownedTicket = await must(service.from('tickets').insert({
  order_id: ownedOrder.id, order_item_id: ownedItem.id, participant_id: ownedParticipant.id,
  event_id: event.id, organization_id: org.id, status: 'active', owner_user_id: ownerUserId,
}).select('id,owner_user_id,token').single(), 'owned ticket');

const bareCpf = generateValidCpf();
const bareContact = await must(service.from('registration_contacts').insert({
  organization_id: org.id, full_name: 'Pessoa Antiga Sem Conta', cpf: bareCpf,
  birth_date: '1988-03-15', gender: 'female', phone: '11988887777', email: `pre49-bare-${suffix}@qa.local`,
  city: 'Itapiranga',
}).select('id').single(), 'bare contact');
const bareParticipant = await must(service.from('participants').insert({
  organization_id: org.id, event_id: event.id, registration_contact_id: bareContact.id,
  full_name: 'Pessoa Antiga Sem Conta', cpf: bareCpf, email: `pre49-bare-${suffix}@qa.local`,
  birth_date: '1988-03-15', gender: 'female', phone: '11988887777', city: 'Itapiranga',
  registration_status: 'confirmed',
}).select('id').single(), 'bare participant');
const bareOrder = await must(service.from('orders').insert({
  organization_id: org.id, event_id: event.id, participant_id: bareParticipant.id,
  order_number: `PRE49-BARE-${suffix}`, status: 'confirmed', base_amount: 100, final_amount: 100,
  buyer_type: 'administrative',
}).select('id').single(), 'bare order');
const bareItem = await must(service.from('order_items').insert({
  order_id: bareOrder.id, event_id: event.id, participant_id: bareParticipant.id,
  registration_contact_id: bareContact.id, item_kind: 'ticket', ticket_category_id: category.id,
  batch_id: batch.id, quantity: 1, unit_price: 100, discount_amount: 0, final_amount: 100,
  status: 'confirmed', ownership_status: 'assigned', holder_full_name: 'Pessoa Antiga Sem Conta',
}).select('id').single(), 'bare item');
const bareTicket = await must(service.from('tickets').insert({
  order_id: bareOrder.id, order_item_id: bareItem.id, participant_id: bareParticipant.id,
  event_id: event.id, organization_id: org.id, status: 'active',
}).select('id,owner_user_id,token').single(), 'bare ticket');

const importBatch = await must(service.from('import_batches').insert({
  import_type: 'current_event_registrations', event_id: event.id, organization_id: org.id,
  imported_by: ownerUserId, total_rows: 1, imported_rows: 1, status: 'completed',
  file_name: 'piloto-teste01-pre49.csv',
}).select('id,status').single(), 'completed batch');
await must(service.from('import_batch_rows').insert({
  import_batch_id: importBatch.id, row_number: 1, status: 'imported', resolution: 'create_new',
  registration_contact_id: bareContact.id, order_item_id: bareItem.id, ticket_id: bareTicket.id,
  normalized_data: { full_name: 'Pessoa Antiga Sem Conta', cpf: bareCpf },
  raw_data: {},
}).select('id').single(), 'completed row');

const snapshot = {
  suffix, orgId: org.id, eventId: event.id, ownerUserId,
  ownedTicketId: ownedTicket.id, ownedTicketOwner: ownedTicket.owner_user_id,
  ownedItemId: ownedItem.id, ownedContactId: ownedContact.id,
  bareTicketId: bareTicket.id, bareTicketOwner: bareTicket.owner_user_id,
  bareItemId: bareItem.id, bareContactId: bareContact.id,
  importBatchId: importBatch.id, importBatchStatus: importBatch.status,
};
await writeFile(new URL('./.pre49-compat-snapshot.json', import.meta.url), JSON.stringify(snapshot, null, 2));
console.log(JSON.stringify(snapshot, null, 2));
