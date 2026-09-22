import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  cadastroAppearsInListing,
  cadastroHrefForOwnedTicket,
  classifyCadastroListing,
  countCadastroOwnedOperationalTickets,
  fichaIncludesOwnedTicket,
  holderOnlyTicketPointers,
  importIdentityMode,
  legacyHolderOwnerLookupIds,
  matchesCadastroListingQuery,
  relatedLegacyHolderTickets,
  singleLegacyHolderOwnerContactId,
  uniqueLegacyHolderOwnerKeys,
  visibleCadastroUniverseSize,
} from '../src/lib/registrations/cadastro-listing.ts';
import { isImportRowReadyToImport } from '../src/lib/imports/batch-operational-state.ts';
import { importRowIdentityMode, isTextualHolderImport } from '../src/lib/imports/identity-review.ts';
import { isOperationalTicketStatus } from '../src/lib/dashboard/operational-shirt-demand.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const BARBARA_USER = 'ffc535d1-50cf-4fc8-b21c-6786cd109715';
const BARBARA_CONTACT = '0987d813-barbara';
const DANIELI_USER = 'danieli-user';
const DANIELI_CONTACT = '9ff0c3d7-danieli';
const JEAN_CONTACT = '354cf045-jean';
const EVENT_MILITRIN = 'event-militrin-2026';

const barbara = { contactId: BARBARA_CONTACT, userId: BARBARA_USER };
const danieli = { contactId: DANIELI_CONTACT, userId: DANIELI_USER };
const jean = { contactId: JEAN_CONTACT, userId: null, hasPendingFirstAccessInvite: false };
const pendingInvite = { contactId: 'pending-b', userId: null, hasPendingFirstAccessInvite: true };
const legacyImported = { contactId: 'maria-eduarda-c', userId: null, hasPendingFirstAccessInvite: false };

const barbaraTickets = [
  {
    ticketId: '1933',
    eventId: EVENT_MILITRIN,
    status: 'active',
    ownerUserId: BARBARA_USER,
    intendedOwnerContactId: BARBARA_CONTACT,
    holderContactId: BARBARA_CONTACT,
  },
  {
    ticketId: '1935',
    eventId: EVENT_MILITRIN,
    status: 'active',
    ownerUserId: BARBARA_USER,
    intendedOwnerContactId: null,
    holderContactId: null,
  },
];

const danieliTickets = [
  {
    ticketId: '1566',
    eventId: EVENT_MILITRIN,
    status: 'active',
    ownerUserId: DANIELI_USER,
    intendedOwnerContactId: DANIELI_CONTACT,
    holderContactId: DANIELI_CONTACT,
  },
  {
    ticketId: '1574',
    eventId: EVENT_MILITRIN,
    status: 'active',
    ownerUserId: DANIELI_USER,
    intendedOwnerContactId: DANIELI_CONTACT,
    holderContactId: JEAN_CONTACT,
  },
];

const allTickets = [...barbaraTickets, ...danieliTickets];

function listingUniverse(contacts, tickets) {
  return contacts.filter((contact) => cadastroAppearsInListing(classifyCadastroListing(contact, tickets)));
}

test('A. owner com 2 tickets e holders diferentes mostra Ingressos = 2', () => {
  const stats = countCadastroOwnedOperationalTickets(barbara, barbaraTickets);
  assert.equal(stats.ticketCount, 2);
  assert.equal(fichaIncludesOwnedTicket({ listingClass: 'A', hasUserId: true, roles: ['owner'] }), true);
  assert.equal(fichaIncludesOwnedTicket({ listingClass: 'A', hasUserId: true, roles: ['holder'] }), false);
});

test('B. 2 tickets no mesmo evento => Eventos = 1', () => {
  assert.equal(countCadastroOwnedOperationalTickets(barbara, barbaraTickets).eventCount, 1);
  assert.equal(countCadastroOwnedOperationalTickets(danieli, danieliTickets).eventCount, 1);
});

test('C. ticket cancelled nao entra na contagem operacional principal', () => {
  const withCancelled = [
    ...barbaraTickets,
    {
      ticketId: '1999',
      eventId: 'other-event',
      status: 'cancelled',
      ownerUserId: BARBARA_USER,
      holderContactId: BARBARA_CONTACT,
    },
    {
      ticketId: '2000',
      eventId: 'other-event',
      status: 'canceled',
      ownerUserId: BARBARA_USER,
      holderContactId: BARBARA_CONTACT,
    },
    {
      ticketId: '2001',
      eventId: 'other-event',
      status: 'void',
      ownerUserId: BARBARA_USER,
      holderContactId: BARBARA_CONTACT,
    },
  ];
  assert.equal(isOperationalTicketStatus('cancelled'), false);
  assert.equal(isOperationalTicketStatus('canceled'), false);
  assert.equal(isOperationalTicketStatus('void'), false);
  const stats = countCadastroOwnedOperationalTickets(barbara, withCancelled);
  assert.equal(stats.ticketCount, 2);
  assert.equal(stats.eventCount, 1);
});

test('D. holder textual sem Cadastro nao cria linha', () => {
  const brunoHasNoContact = allTickets.filter((ticket) => ticket.holderContactId === null);
  assert.equal(brunoHasNoContact.some((ticket) => ticket.ticketId === '1935'), true);
  const contacts = [barbara, danieli, jean, pendingInvite, legacyImported];
  assert.equal(contacts.some((contact) => /bruno/i.test(contact.contactId)), false);
});

test('E. classe E historica nao aparece em /cadastros', () => {
  assert.equal(classifyCadastroListing(jean, allTickets), 'E');
  assert.equal(cadastroAppearsInListing('E'), false);
  const visible = listingUniverse([barbara, danieli, jean, pendingInvite, legacyImported], allTickets);
  assert.deepEqual(visible.map((contact) => contact.contactId), [
    BARBARA_CONTACT,
    DANIELI_CONTACT,
    pendingInvite.contactId,
    legacyImported.contactId,
  ]);
});

test('F. classe B pending invite continua aparecendo', () => {
  assert.equal(classifyCadastroListing(pendingInvite, allTickets), 'B');
  assert.equal(cadastroAppearsInListing('B'), true);
});

test('G. classe C legado legitimo continua aparecendo', () => {
  const ownUnowned = [{
    ticketId: 'legacy-1',
    eventId: EVENT_MILITRIN,
    status: 'active',
    ownerUserId: null,
    intendedOwnerContactId: legacyImported.contactId,
    holderContactId: legacyImported.contactId,
  }];
  assert.equal(classifyCadastroListing(legacyImported, ownUnowned), 'C');
  assert.equal(cadastroAppearsInListing('C'), true);
  assert.equal(countCadastroOwnedOperationalTickets(legacyImported, ownUnowned).ticketCount, 1);
});

test('H. busca q por Jean nao retorna Cadastro fantasma', () => {
  const contacts = [
    { ...barbara, name: 'Bárbara Züge' },
    { ...danieli, name: 'Danieli Weber da Conceição' },
    { ...jean, name: 'Jean Lucas Pinheiro Rodrigues' },
    { ...pendingInvite, name: 'Pessoa convite' },
    { ...legacyImported, name: 'Maria Eduarda' },
  ];
  const visible = listingUniverse(contacts, allTickets)
    .filter((contact) => matchesCadastroListingQuery(contact, 'Jean'));
  assert.equal(visible.length, 0);
  assert.equal(matchesCadastroListingQuery({ name: 'Jean Lucas Pinheiro Rodrigues' }, 'Jean'), true);
  assert.equal(cadastroAppearsInListing(classifyCadastroListing(jean, allTickets)), false);
});

test('I. busca operacional pelo ingresso/titular Jean continua no ingresso', async () => {
  const [listTicketsSql, operacoes] = await Promise.all([
    read('supabase/migrations/20261029000000_canonical_ticket_display_code.sql'),
    read('src/app/operacoes/actions.ts'),
  ]);
  assert.match(listTicketsSql, /f\.holder_name ilike '%' \|\| v_search \|\| '%'/);
  assert.match(operacoes, /canonicalHolderName\(/);
  assert.match(operacoes, /row\.participant_name/);
  assert.doesNotMatch(operacoes, /href=\{`\/cadastros\/\$\{/);
});

test('J. importacao de titular adicional NAO cria registration_contact permanente', async () => {
  const sql = await read('supabase/migrations/20261110000000_cadastro_textual_holder_import.sql');
  const textual = sql.slice(sql.indexOf("if v_identity_mode='textual_holder' then"));
  const cadastro = sql.slice(sql.indexOf('if p_expected_registration_contact_id is not null then'));
  assert.match(textual, /v_holder_name:=trim\(p_full_name\)/);
  assert.match(textual, /values\(v_order\.id,v_event\.id,null,null,v_intended,'assigned',v_holder_name/);
  assert.match(textual, /created_contact',false/);
  assert.match(textual, /Importe primeiro o Cadastro proprietario/);
  assert.doesNotMatch(textual.slice(0, textual.indexOf('if p_expected_registration_contact_id')), /insert into public\.registration_contacts/);
  assert.match(cadastro, /insert into public\.registration_contacts/);
});

test('K. importacao de pessoa principal continua criando/reutilizando Cadastro', async () => {
  const [sql, actions] = await Promise.all([
    read('supabase/migrations/20261110000000_cadastro_textual_holder_import.sql'),
    read('src/app/importacoes/actions.ts'),
  ]);
  assert.match(sql, /p_identity_mode text default 'cadastro'/);
  assert.match(sql, /identity_mode','cadastro'/);
  assert.match(actions, /p_identity_mode: identityMode/);
  assert.equal(importRowIdentityMode({ identity_mode: 'cadastro' }), 'cadastro');
  assert.equal(isImportRowReadyToImport('review_required', 'create_new'), true);
});

test('L. shared-email assign_owner vira titular textual sem Cadastro fantasma novo', async () => {
  const [sql, actions, revisoes] = await Promise.all([
    read('supabase/migrations/20261110000000_cadastro_textual_holder_import.sql'),
    read('src/app/importacoes/actions.ts'),
    read('src/app/importacoes/revisoes/page.tsx'),
  ]);
  assert.match(sql, /create or replace function public\.apply_shared_email_textual_holders/);
  assert.match(sql, /resolution='textual_holder'/);
  assert.match(actions, /import_as_textual_holder/);
  assert.match(actions, /apply_shared_email_textual_holders/);
  assert.match(revisoes, /Somente titular deste ingresso \(sem Cadastro\)/);
  assert.equal(isTextualHolderImport({ resolution: 'textual_holder' }), true);
  assert.equal(importIdentityMode({ identity_mode: 'textual_holder' }), 'textual_holder');
});

test('M. checkout nomeado Bruno permanece textual, sem Cadastro automatico', async () => {
  const [checkoutSql, wizard, holderRpc] = await Promise.all([
    read('supabase/migrations/20261030000000_named_checkout_textual_holder_only.sql'),
    read('src/app/inscricao/[eventSlug]/wizard.tsx'),
    read('supabase/migrations/20261028000000_ticket_holder_textual_name.sql'),
  ]);
  assert.match(checkoutSql, /participant_id = null/);
  assert.match(checkoutSql, /registration_contact_id = null/);
  assert.doesNotMatch(
    checkoutSql.slice(checkoutSql.indexOf('create or replace function public.materialize_named_checkout_holders')),
    /insert into public\.registration_contacts/,
  );
  assert.match(wizard, /Não cria Cadastro, conta nem transfere a propriedade/);
  assert.match(holderRpc, /admin_set_ticket_holder_name/);
});

test('N. listagem nao altera ownership para resolver problema visual', async () => {
  const [listing, page, ficha] = await Promise.all([
    read('src/lib/registrations/cadastro-listing.ts'),
    read('src/app/cadastros/page.tsx'),
    read('src/app/cadastros/[id]/page.tsx'),
  ]);
  assert.doesNotMatch(listing, /\.update\(|DELETE FROM|from\("tickets"\)\.update/i);
  assert.doesNotMatch(page, /\.update\(|\.delete\(/);
  assert.match(ficha, /Esta pessoa não é um Cadastro/);
  assert.match(ficha, /uniqueOwnerKeys\.length > 1/);
  assert.equal(countCadastroOwnedOperationalTickets(danieli, danieliTickets).ticketCount, 2);
  assert.equal(classifyCadastroListing(jean, allTickets), 'E');
});

test('Bárbara: #1935 titular Bruno nao some da conta; Ingressos=2 Eventos=1', () => {
  const stats = countCadastroOwnedOperationalTickets(barbara, barbaraTickets);
  assert.equal(stats.ticketCount, 2);
  assert.equal(stats.eventCount, 1);
  assert.equal(barbaraTickets.find((ticket) => ticket.ticketId === '1935')?.holderContactId, null);
  assert.equal(barbaraTickets.find((ticket) => ticket.ticketId === '1935')?.ownerUserId, BARBARA_USER);
});

test('Danieli aparece com 2; Jean nao; href de Cadastro aponta owner', () => {
  assert.equal(countCadastroOwnedOperationalTickets(danieli, danieliTickets).ticketCount, 2);
  assert.equal(cadastroAppearsInListing(classifyCadastroListing(jean, allTickets)), false);
  assert.equal(cadastroHrefForOwnedTicket({
    ownerContactId: DANIELI_CONTACT,
    holderContactId: JEAN_CONTACT,
    ticketId: '1574',
  }), `/cadastros/${DANIELI_CONTACT}`);
  const pointers = holderOnlyTicketPointers(JEAN_CONTACT, allTickets, new Map([[DANIELI_USER, DANIELI_CONTACT]]));
  assert.equal(pointers.length, 1);
  assert.equal(pointers[0].ownerContactId, DANIELI_CONTACT);
});

test('snapshot 804-29=775 e evidencia, nao regra de negocio hardcoded', () => {
  assert.equal(visibleCadastroUniverseSize(804, 29), 775);
  assert.equal(visibleCadastroUniverseSize(10, 3), 7);
  const listingPagePromise = read('src/app/cadastros/page.tsx');
  return listingPagePromise.then((page) => {
    assert.doesNotMatch(page, /775/);
    assert.match(page, /cadastroAppearsInListing/);
    assert.match(page, /owner_user_id/);
    assert.match(page, /matchesCadastroListingQuery/);
  });
});

test('dashboard Pessoas no evento permanece titular/pessoa fisica, link vai ao owner', async () => {
  const dashboard = await read('src/lib/dashboard/admin-dashboard-data.ts');
  assert.match(dashboard, /Pessoas no evento" = titulares\/pessoas físicas/);
  assert.match(dashboard, /Titular no evento/);
  assert.match(dashboard, /cadastroHrefForOwnedTicket/);
  assert.match(dashboard, /put\('people', 'Pessoas no evento'/);
});

test('hotfix E: lookup de owners nao usa tickets da organizacao inteira', async () => {
  const noise = Array.from({ length: 80 }, (_, index) => ({
    ticketId: `noise-${index}`,
    eventId: `event-${index}`,
    status: 'active',
    ownerUserId: `owner-user-${index}`,
    intendedOwnerContactId: `owner-contact-${index}`,
    holderContactId: `holder-${index}`,
  }));
  const tickets = [...allTickets, ...noise];
  const lookup = legacyHolderOwnerLookupIds(JEAN_CONTACT, tickets);
  assert.deepEqual(lookup.ownerUserIds, [DANIELI_USER]);
  assert.deepEqual(lookup.intendedOwnerIds, [DANIELI_CONTACT]);
  assert.equal(relatedLegacyHolderTickets(JEAN_CONTACT, tickets).length, 1);
  const ficha = await read('src/app/cadastros/[id]/page.tsx');
  assert.match(ficha, /legacyHolderOwnerLookupIds\(id, listingTickets\)/);
  assert.doesNotMatch(ficha, /listingTickets\.flatMap\(\(ticket\) => \(ticket\.ownerUserId/);
  assert.match(ficha, /Titular de ingresso/);
});

test('A. classe E + um ticket + um owner renderiza sem 500 e aponta Danieli', () => {
  const ownerMap = new Map([[DANIELI_USER, DANIELI_CONTACT]]);
  const pointers = holderOnlyTicketPointers(JEAN_CONTACT, allTickets, ownerMap);
  assert.equal(classifyCadastroListing(jean, allTickets), 'E');
  assert.equal(pointers.length, 1);
  assert.equal(pointers[0].ticketId, '1574');
  assert.equal(pointers[0].ownerContactId, DANIELI_CONTACT);
  assert.equal(singleLegacyHolderOwnerContactId(pointers), DANIELI_CONTACT);
  assert.equal(cadastroHrefForOwnedTicket({
    ownerContactId: singleLegacyHolderOwnerContactId(pointers),
    ticketId: pointers[0].ticketId,
  }), `/cadastros/${DANIELI_CONTACT}`);
});

test('B. classe E + multiplos tickets mesmo owner mostra owner unico', () => {
  const sameOwner = [
    ...danieliTickets,
    {
      ticketId: '1575',
      eventId: EVENT_MILITRIN,
      status: 'used',
      ownerUserId: DANIELI_USER,
      intendedOwnerContactId: DANIELI_CONTACT,
      holderContactId: JEAN_CONTACT,
    },
  ];
  const pointers = holderOnlyTicketPointers(JEAN_CONTACT, sameOwner, new Map([[DANIELI_USER, DANIELI_CONTACT]]));
  assert.equal(pointers.length, 2);
  assert.deepEqual(uniqueLegacyHolderOwnerKeys(pointers), [DANIELI_CONTACT]);
  assert.equal(singleLegacyHolderOwnerContactId(pointers), DANIELI_CONTACT);
});

test('C. classe E + multiplos owners nao escolhe Cadastro arbitrario', () => {
  const otherUser = 'other-owner-user';
  const otherContact = 'other-owner-contact';
  const multi = [
    ...danieliTickets,
    {
      ticketId: '2002',
      eventId: 'other-event',
      status: 'active',
      ownerUserId: otherUser,
      intendedOwnerContactId: otherContact,
      holderContactId: JEAN_CONTACT,
    },
  ];
  const pointers = holderOnlyTicketPointers(JEAN_CONTACT, multi, new Map([
    [DANIELI_USER, DANIELI_CONTACT],
    [otherUser, otherContact],
  ]));
  assert.equal(pointers.length, 2);
  assert.equal(uniqueLegacyHolderOwnerKeys(pointers).length, 2);
  assert.equal(singleLegacyHolderOwnerContactId(pointers), null);
});

test('D. classe A ficha continua so com tickets owned', () => {
  assert.equal(classifyCadastroListing(barbara, barbaraTickets), 'A');
  assert.equal(fichaIncludesOwnedTicket({ listingClass: 'A', hasUserId: true, roles: ['owner'] }), true);
  assert.equal(fichaIncludesOwnedTicket({ listingClass: 'A', hasUserId: true, roles: ['holder'] }), false);
  assert.equal(fichaIncludesOwnedTicket({ listingClass: 'E', hasUserId: false, roles: ['holder'] }), false);
});

test('E. classe B/C permanecem Cadastro normal', () => {
  assert.equal(classifyCadastroListing(pendingInvite, allTickets), 'B');
  assert.equal(cadastroAppearsInListing('B'), true);
  const ownUnowned = [{
    ticketId: 'legacy-1',
    eventId: EVENT_MILITRIN,
    status: 'active',
    ownerUserId: null,
    intendedOwnerContactId: legacyImported.contactId,
    holderContactId: legacyImported.contactId,
  }];
  assert.equal(classifyCadastroListing(legacyImported, ownUnowned), 'C');
  assert.equal(cadastroAppearsInListing('C'), true);
});

test('F. Jean continua invisivel na busca de Cadastros', () => {
  const contacts = [
    { ...barbara, name: 'Bárbara Züge' },
    { ...danieli, name: 'Danieli Weber da Conceição' },
    { ...jean, name: 'Jean Lucas Pinheiro Rodrigues' },
    { ...pendingInvite, name: 'Pessoa convite' },
    { ...legacyImported, name: 'Maria Eduarda' },
  ];
  const visible = listingUniverse(contacts, allTickets)
    .filter((contact) => matchesCadastroListingQuery(contact, 'Jean'));
  assert.equal(visible.length, 0);
});

test('G. Bárbara continua 2 ingressos / 1 evento', () => {
  const stats = countCadastroOwnedOperationalTickets(barbara, barbaraTickets);
  assert.equal(stats.ticketCount, 2);
  assert.equal(stats.eventCount, 1);
});

test('H. Danieli continua 2', () => {
  assert.equal(countCadastroOwnedOperationalTickets(danieli, danieliTickets).ticketCount, 2);
});
