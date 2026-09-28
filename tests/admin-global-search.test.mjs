import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { classifyAdminSearchQuery, globalSearchPlan, nameMatchesQuery, phoneDigitsMatch } from '../src/lib/admin/global-search/classify.ts';
import { flattenSearchHits } from '../src/lib/admin/global-search/present.ts';
import { presentOrderFromSupport, presentPersonHit, presentTicketHit, presentWristbandHit } from '../src/lib/admin/global-search/present.ts';
import { maskCpfForSearch, maskWristbandForSearch } from '../src/lib/admin/global-search/mask.ts';
import { GLOBAL_SEARCH_GROUP_LIMIT, GLOBAL_SEARCH_NAME_MIN_CHARS } from '../src/lib/admin/global-search/constants.ts';
import { sanitizeSearchError } from '../src/lib/admin/global-search/errors.ts';
import { presentSupportOrder } from '../src/lib/orders/support-presentation.ts';

test('A nome e B sobrenome classificam busca textual e toleram case/acento', () => {
  assert.equal(classifyAdminSearchQuery('Higor').kind, 'name');
  assert.equal(classifyAdminSearchQuery('bandeira').kind, 'name');
  assert.equal(nameMatchesQuery('Higor Luis Bandeira', 'higor'), true);
  assert.equal(nameMatchesQuery('Higor Luis Bandeira', 'BANDEIRA'), true);
  assert.equal(nameMatchesQuery('José da Silva', 'jose'), true);
  assert.equal(nameMatchesQuery('Higor Luis Bandeira', 'x'), false);
});

test('C/D CPF formatado e só dígitos viram a mesma identidade', () => {
  const formatted = classifyAdminSearchQuery('049.581.540-35');
  const digits = classifyAdminSearchQuery('04958154035');
  assert.equal(formatted.kind, 'cpf');
  assert.equal(digits.kind, 'cpf');
  assert.equal(formatted.cpfDigits, digits.cpfDigits);
  assert.equal(formatted.cpfDigits, '04958154035');
});

test('E e-mail normaliza trim/lowercase', () => {
  const classified = classifyAdminSearchQuery('  Rita.Kieling@Example.COM ');
  assert.equal(classified.kind, 'email');
  assert.equal(classified.email, 'rita.kieling@example.com');
});

test('F telefone normaliza dígitos e não confunde com CPF válido', () => {
  const classified = classifyAdminSearchQuery('(51) 99999-8888');
  assert.equal(classified.kind, 'phone');
  assert.equal(classified.phoneDigits, '51999998888');
  assert.equal(phoneDigitsMatch('5551999998888', '51999998888'), true);
});

test('G/H pedido aceita 1966, #1966, #001966 e MIL', () => {
  for (const raw of ['1966', '#1966', '#001966', 'MIL-2026-00001966']) {
    const classified = classifyAdminSearchQuery(raw);
    assert.equal(classified.kind, 'order', raw);
    assert.ok(classified.orderQuery);
  }
  const mil = classifyAdminSearchQuery('MIL-2026-00002055');
  assert.equal(mil.kind, 'order');
  assert.equal(mil.orderQuery?.kind, 'mil');
  assert.equal(mil.orderQuery?.canonical, 'MIL-2026-00002055');
});

test('I ingresso e J QR/token reusam parser canônico', () => {
  const ticket = classifyAdminSearchQuery('#001687-01');
  assert.equal(ticket.kind, 'ticket');
  assert.equal(ticket.ticketCode?.displayNumber, 1687);
  assert.equal(ticket.ticketCode?.itemPosition, 1);
  const qr = classifyAdminSearchQuery('https://www.militrin.com.br/ingresso?token=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(qr.kind, 'uuid');
  assert.equal(qr.uuid, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
});

test('K pulseira reconhece código longo sem tratar como CPF', () => {
  const classified = classifyAdminSearchQuery('050221801021167116');
  assert.equal(classified.kind, 'wristband');
  assert.equal(classified.wristbandCode, '050221801021167116');
});

test('P termo curto e Q nenhum resultado quando nenhum domínio é permitido', () => {
  assert.equal(classifyAdminSearchQuery('hi').kind, 'too_short');
  assert.equal(GLOBAL_SEARCH_NAME_MIN_CHARS, 3);
  const plan = globalSearchPlan('name', { participantsView: false, ordersView: false, wristbandsView: false });
  assert.equal(plan.people, false);
  assert.equal(plan.orders, false);
  assert.equal(plan.tickets, false);
  assert.equal(plan.wristbands, false);
});

test('L/M/N/O RBAC não abre domínio sem permissão', () => {
  const none = globalSearchPlan('name', { participantsView: false, ordersView: false, wristbandsView: false });
  assert.deepEqual(none, { people: false, orders: false, tickets: false, wristbands: false });

  const peopleOnly = globalSearchPlan('name', { participantsView: true, ordersView: false, wristbandsView: false });
  assert.equal(peopleOnly.people, true);
  assert.equal(peopleOnly.orders, false);
  assert.equal(peopleOnly.tickets, true);
  assert.equal(peopleOnly.wristbands, false);

  const ordersOnly = globalSearchPlan('order', { participantsView: false, ordersView: true, wristbandsView: false });
  assert.equal(ordersOnly.people, false);
  assert.equal(ordersOnly.orders, true);
  assert.equal(ordersOnly.tickets, false);

  const ticketsViaOrders = globalSearchPlan('ticket', { participantsView: false, ordersView: true, wristbandsView: false });
  assert.equal(ticketsViaOrders.tickets, true);
  assert.equal(ticketsViaOrders.people, false);

  const ordersOnlyName = globalSearchPlan('name', { participantsView: false, ordersView: true, wristbandsView: false });
  assert.equal(ordersOnlyName.people, false);
  assert.equal(ordersOnlyName.orders, false, 'nome sem participants.view não vira índice de compradores');
  assert.equal(ordersOnlyName.tickets, true);

  const ordersOnlyOrder = globalSearchPlan('order', { participantsView: false, ordersView: true, wristbandsView: false });
  assert.equal(ordersOnlyOrder.orders, true);
  assert.equal(ordersOnlyOrder.people, false);

  const wristbandOnly = globalSearchPlan('wristband', { participantsView: false, ordersView: false, wristbandsView: true });
  assert.equal(wristbandOnly.wristbands, true);
  assert.equal(wristbandOnly.people, false);
  assert.equal(wristbandOnly.tickets, false);
});

test('R limite por grupo e flatten inclui Ver mais', () => {
  const hits = Array.from({ length: 7 }, (_, index) => presentPersonHit({
    id: `p${index}`,
    name: `Pessoa ${index}`,
    cpf: '04958154035',
    userId: 'u',
  }));
  assert.equal(hits.slice(0, GLOBAL_SEARCH_GROUP_LIMIT).length, 5);
  const flat = flattenSearchHits([{
    id: 'people',
    label: 'Pessoas',
    hits: hits.slice(0, 5),
    total: 7,
    hasMore: true,
    moreHref: '/cadastros?q=a',
  }]);
  assert.equal(flat.at(-1)?.cta, 'Ver mais');
});

test('S CPF mascarado e pulseira mascarada nunca despejam o valor completo', () => {
  assert.equal(maskCpfForSearch('04958154035'), '•••.•••.•••-35');
  assert.doesNotMatch(maskCpfForSearch('04958154035'), /04958154035/);
  assert.match(maskWristbandForSearch('050221801021167116'), /^0502••••7116$/);
});

test('status comercial e operacional reusam helpers canônicos, sem active/used cru', () => {
  const paid = presentSupportOrder({
    orderId: 'o1',
    displayNumber: 2055,
    orderNumber: 'MIL-2026-00002055',
    orderStatus: 'confirmed',
    buyerType: 'account',
    finalAmount: 89.49,
    payment: { payment_status: 'paid', payment_method: 'PIX', paid_at: '2026-09-01T12:00:00.000Z', amount: 89.49 },
  });
  const orderHit = presentOrderFromSupport(paid, { buyerName: 'Rita Kieling', orderId: 'o1', priceOrigin: 'catalog' });
  assert.equal(orderHit.statusKey, 'paid');
  assert.equal(orderHit.statusLabel, 'PAGO');
  assert.match(orderHit.href ?? '', /\/inscricoes\/pedido\/o1/);

  const expired = presentSupportOrder({
    orderId: 'o2',
    displayNumber: 1966,
    orderStatus: 'pending',
    payment: { payment_status: 'pending', payment_method: 'PIX', expires_at: '2026-01-01T00:00:00.000Z' },
    now: new Date('2026-09-28T12:00:00-03:00'),
  });
  const expiredHit = presentOrderFromSupport(expired, { buyerName: 'Rita Kieling', orderId: 'o2' });
  assert.equal(expiredHit.statusKey, 'expired');
  const orderWithoutBuyer = presentOrderFromSupport(paid, { buyerName: null, orderId: 'o1', showAmount: false });
  assert.equal(orderWithoutBuyer.subtitle, null);
  assert.doesNotMatch(orderWithoutBuyer.meta ?? '', /R\$/);

  const ticket = presentTicketHit({
    ticketId: 't1',
    ticketReference: '#001687-01',
    holderName: 'Erick Vinicius Marquiori',
    categoryName: 'Open Bar',
    eventName: 'Militrin',
    status: 'active',
  });
  assert.equal(ticket.statusLabel, 'ATIVO');
  assert.doesNotMatch(ticket.statusLabel ?? '', /^active$/i);
  const usedTicket = presentTicketHit({
    ticketId: 't-used',
    ticketReference: '#001234-01',
    holderName: 'Higor Luis Bandeira',
    status: 'used',
  });
  assert.equal(usedTicket.statusLabel, 'UTILIZADO');
  assert.doesNotMatch(usedTicket.statusLabel ?? '', /used/i);

  const wristband = presentWristbandHit({
    id: 'w1',
    code: '050221801021167116',
    status: 'active',
    holderName: 'Higor Luis Bandeira',
    eventName: 'Militrin',
    ticketId: 't2',
    canOpenTicket: true,
  });
  assert.equal(wristband.statusLabel, 'VINCULADA');
  assert.equal(wristband.href, '/ingressos/t2');
});

test('T busca não expõe writers nem mutação', async () => {
  const files = await Promise.all([
    readFile(new URL('../src/lib/admin/global-search/action.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/admin/global-search/search.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/admin/global-search/sources.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/admin/global-search/errors.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/admin/global-search/GlobalSearchHost.tsx', import.meta.url), 'utf8'),
  ]);
  const joined = files.join('\n');
  assert.match(files[0], /canAccessAdministrativePanel/);
  assert.match(files[0], /participants\.view/);
  assert.match(files[0], /orders\.view/);
  assert.match(files[0], /wristbands\.view/);
  assert.doesNotMatch(joined, /\.insert\(/);
  assert.doesNotMatch(joined, /\.update\(/);
  assert.doesNotMatch(joined, /\.delete\(/);
  assert.doesNotMatch(joined, /\.upsert\(/);
  assert.doesNotMatch(joined, /revalidatePath/);
  assert.doesNotMatch(joined, /checkin_ticket_entry|deliver_ticket|link_wristband|unlink_wristband|replace_wristband/);
  assert.match(files[1], /sanitizeSearchError/);
  assert.doesNotMatch(files[1], /message: error instanceof Error && error\.message/);
  assert.match(files[1], /classified\.kind === "name" && ctx\.permissions\.participantsView/);
  assert.doesNotMatch(files[2], /get_registration_contact_account_state/);
  assert.doesNotMatch(files[2], /listAdminTickets|list_admin_tickets/);
  assert.doesNotMatch(files[2], /order_items\(holder_full_name\), participants\(full_name\)/);
  assert.match(files[2], /includeBuyerIdentity/);
  assert.match(files[2], /if \(!includeBuyerIdentity\(ctx\)\) return/);
});

test('erro da busca nunca devolve SQL, tabela ou stack', () => {
  const message = sanitizeSearchError(new Error('relation "registration_contacts" does not exist'));
  assert.equal(message, 'Não foi possível realizar a busca. Tente novamente.');
  assert.doesNotMatch(message, /registration_contacts|postgres|at /i);
});

test('identificador exato não mistura pulseira, telefone e pedido', () => {
  assert.equal(classifyAdminSearchQuery('1966').kind, 'order');
  assert.equal(classifyAdminSearchQuery('#001687-01').kind, 'ticket');
  assert.equal(classifyAdminSearchQuery('050221801021167116').kind, 'wristband');
  assert.notEqual(classifyAdminSearchQuery('050221801021167116').kind, 'phone');
  assert.notEqual(classifyAdminSearchQuery('050221801021167116').kind, 'name');
  assert.equal(classifyAdminSearchQuery('51999998888').kind, 'phone');
});

