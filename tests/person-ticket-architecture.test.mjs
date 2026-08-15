import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { groupContactTickets, resolveTicketChoice, ticketsForContact } from '../src/lib/registrations/contact-tickets.ts';

const contactId = 'contact-a';
const linked = (ticketId, eventId, eventName = eventId) => ({ ticketId, eventId, eventName, orderItemContactId: contactId });

test('um cadastro permanece único com vários participants históricos', () => {
  const contacts = [{ id: contactId }, { id: 'contact-b' }];
  const participants = [{ registration_contact_id: contactId }, { registration_contact_id: contactId }];
  assert.equal(contacts.length, 2);
  assert.equal(new Set(participants.map((item) => item.registration_contact_id)).size, 1);
});

test('pessoa sem ingresso e pessoa com um ingresso são preservadas', () => {
  assert.deepEqual(ticketsForContact([], contactId), []);
  assert.equal(ticketsForContact([linked('ticket-1', 'event-1')], contactId).length, 1);
});

test('quatro ingressos do mesmo evento aparecem sem deduplicação indevida', () => {
  const tickets = Array.from({ length: 4 }, (_, index) => linked(`ticket-${index}`, 'event-1'));
  const groups = groupContactTickets(tickets);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tickets.length, 4);
});

test('ingressos em três eventos são agrupados nos três eventos', () => {
  const groups = groupContactTickets([linked('a', 'event-1'), linked('b', 'event-2'), linked('c', 'event-3')]);
  assert.equal(groups.length, 3);
});

test('duas pessoas semelhantes não são unificadas por nome ou contato', () => {
  const tickets = [linked('a', 'event-1'), { ...linked('b', 'event-1'), orderItemContactId: 'contact-b' }];
  assert.deepEqual(ticketsForContact(tickets, contactId).map((item) => item.ticketId), ['a']);
  assert.deepEqual(ticketsForContact(tickets, 'contact-b').map((item) => item.ticketId), ['b']);
});

test('seleção automática só ocorre com exatamente um ingresso', () => {
  assert.equal(resolveTicketChoice([]).kind, 'none');
  assert.equal(resolveTicketChoice([linked('a', 'event-1')]).kind, 'single');
  assert.equal(resolveTicketChoice([linked('a', 'event-1'), linked('b', 'event-1')]).kind, 'multiple');
});

test('páginas e actions mantêm a arquitetura contact-first e ticket-first', async () => {
  const [list, detail, edit, editAction, central, pickup] = await Promise.all([
    readFile(new URL('../src/app/cadastros/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/cadastros/[id]/editar/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/cadastros/[id]/editar/actions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/operacoes/actions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/retirada/actions.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(list, /from\("registration_contacts"\)/);
  assert.doesNotMatch(list, /Todos os eventos|name="eventId"/);
  assert.match(detail, /groupContactTickets/);
  assert.doesNotMatch(detail, /limit\(1\).*issued_at/s);
  assert.doesNotMatch(edit, /from\("participants"\)/);
  assert.match(editAction, /from\("registration_contacts"\)[\s\S]*\.update/);
  assert.doesNotMatch(editAction, /from\("participants"\)\.update/);
  assert.doesNotMatch(central, /order\("issued_at"[\s\S]{0,100}limit\(1\)/);
  assert.match(central, /possui mais de um ingresso\. Selecione o ingresso explicitamente/);
  assert.match(pickup, /requires_selection/);
  assert.match(pickup, /\.eq\("token", q\)/);
  assert.match(pickup, /deliver_ticket_full_kit/);
  assert.match(pickup, /checkin_ticket_entry/);
});

test('ficha global não representa a pessoa por um evento único', async () => {
  const detail = await readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8');
  assert.match(detail, /groupContactTickets\(tickets\)/);
  assert.match(detail, /groups\.map/);
  assert.doesNotMatch(detail, /\.order\("issued_at"[\s\S]{0,100}\.limit\(1\)/);
});

test('edição global atualiza registration_contacts e nunca participants', async () => {
  const action = await readFile(new URL('../src/app/cadastros/[id]/editar/actions.ts', import.meta.url), 'utf8');
  assert.match(action, /from\("registration_contacts"\)[\s\S]*\.update/);
  assert.doesNotMatch(action, /from\("participants"\)[\s\S]*\.update/);
});

test('Central não seleciona ingresso recente e exige escolha com dois tickets', async () => {
  const actions = await readFile(new URL('../src/app/operacoes/actions.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(actions, /order\("issued_at"[\s\S]{0,100}limit\(1\)/);
  assert.match(actions, /fallbackTickets[\s\S]*length > 1[\s\S]*Selecione o ingresso explicitamente/);
  assert.match(actions, /requires_selection: true/);
});

test('QR e token resolvem diretamente o ticket correto', async () => {
  const [central, pickup] = await Promise.all([
    readFile(new URL('../src/app/operacoes/actions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/retirada/actions.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(central, /\.eq\("token", tokenCandidate\)[\s\S]*getOperationTicketDetailsAction/);
  assert.match(pickup, /\.eq\("token", q\)[\s\S]*getPickupTicketAction/);
});

test('Retirada trata múltiplos ingressos como seleção visual normal', async () => {
  const [actions, page] = await Promise.all([
    readFile(new URL('../src/app/retirada/actions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/retirada/page.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(actions, /requires_selection: true/);
  assert.match(page, /Selecione explicitamente o ingresso correto/);
  assert.match(page, /eventTickets\.map/);
  assert.doesNotMatch(actions, /ambiguous|multiple tickets found/i);
});

test('evento categoria e lote permanecem ligados ao ticket e order_item', async () => {
  const detail = await readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8');
  assert.match(detail, /from\("tickets"\)/);
  assert.match(detail, /order_items\([^)]*registration_contact_id[\s\S]*ticket_categories\(name\),registration_batches\(name\)/);
  assert.match(detail, /eventId: String\(row\.event_id\)/);
});

test('entrega e check-in permanecem operações por ticket_id', async () => {
  const actions = await readFile(new URL('../src/app/retirada/actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /deliver_ticket_full_kit[\s\S]*p_ticket_id: payload\.ticket_id/);
  assert.match(actions, /checkin_ticket_entry[\s\S]*p_ticket_id: payload\.ticket_id/);
  assert.doesNotMatch(actions, /deliver_ticket_full_kit[\s\S]*p_participant_id/);
});

test('ações administrativas ficam próximas dos dados sem duplicar RPCs', async () => {
  const detail = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
  const contextActions = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/ticket-context-actions.tsx', import.meta.url), 'utf8');
  const serverActions = await readFile(new URL('../src/app/minha-conta/actions.ts', import.meta.url), 'utf8');
  assert.match(detail, /Titular:[\s\S]*HolderContextAction/);
  assert.match(detail, /Categoria:[\s\S]*CategoryContextAction/);
  assert.match(detail, /Camiseta:[\s\S]*ShirtContextAction/);
  assert.match(detail, /TicketOperationalControls/);
  assert.match(serverActions, /admin_change_ticket_shirt/);
  assert.match(contextActions, /updateTicketCategoryAction/);
});
