import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTicketIdentityView,
  contactTicketRoleLabel,
  rolesForContactTicket,
} from '../src/lib/registrations/contact-tickets.ts';

const ANA_AUTH = 'auth-ana';
const ANA_CADASTRO = 'cadastro-ana';
const BARBARA_AUTH = 'auth-barbara';
const BARBARA_CADASTRO = 'cadastro-barbara';
const DOUGLAS_AUTH = 'auth-douglas';
const JOAO_CADASTRO = 'cadastro-joao';
const ROBERTO_CADASTRO = 'cadastro-roberto';

function anaIdentity(overrides = {}) {
  return buildTicketIdentityView({
    holderName: 'Ana Luiza Schapanski',
    holderContactUserId: ANA_AUTH,
    ownerUserId: null,
    intendedOwnerContactId: ANA_CADASTRO,
    intendedOwnerName: 'Ana Luiza Schapanski',
    ticketStatus: 'used',
    buyerType: 'imported_holder',
    ...overrides,
  });
}

function barbaraIdentity(overrides = {}) {
  return buildTicketIdentityView({
    holderName: 'Bárbara Steffen',
    holderContactUserId: BARBARA_AUTH,
    ownerUserId: null,
    intendedOwnerContactId: BARBARA_CADASTRO,
    intendedOwnerName: 'Bárbara Steffen',
    ticketStatus: 'active',
    buyerType: 'imported_holder',
    ...overrides,
  });
}

function assertNeverAwaitsFirstAccess(identity) {
  const blob = JSON.stringify(identity);
  assert.equal(identity.holderAccountLabel, 'Ativa');
  assert.doesNotMatch(blob, /aguardando primeiro acesso/i);
  assert.doesNotMatch(identity.ownerName, /aguardando/i);
}

test('ANA: titular com conta ativa, owner null, intended = cadastro Ana', () => {
  const identity = anaIdentity();
  assert.equal(identity.holderName, 'Ana Luiza Schapanski');
  assert.equal(identity.holderAccountKind, 'active');
  assert.equal(identity.holderAccountLabel, 'Ativa');
  assert.equal(identity.ownerName, 'Não definido');
  assert.equal(identity.intendedOwnerName, 'Ana Luiza Schapanski');
  assertNeverAwaitsFirstAccess(identity);
  assert.equal(
    contactTicketRoleLabel(rolesForContactTicket({
      ticketId: 't-ana',
      eventId: 'e',
      eventName: 'Evento',
      ownerUserId: null,
      intendedOwnerContactId: ANA_CADASTRO,
      orderItemContactId: ANA_CADASTRO,
      participantContactId: ANA_CADASTRO,
    }, ANA_CADASTRO, [ANA_AUTH])),
    'Titular',
  );
});

test('BÁRBARA: mesma semântica da Ana em ingresso active', () => {
  const identity = barbaraIdentity();
  assert.equal(identity.holderName, 'Bárbara Steffen');
  assert.equal(identity.holderAccountLabel, 'Ativa');
  assert.equal(identity.ownerName, 'Não definido');
  assert.equal(identity.intendedOwnerName, 'Bárbara Steffen');
  assertNeverAwaitsFirstAccess(identity);
});

test('ANA materializada: titular ativa, proprietario Ana, pretendido some', () => {
  const identity = anaIdentity({
    ownerUserId: ANA_AUTH,
    ownerName: 'Ana Luiza Schapanski',
  });
  assert.equal(identity.holderAccountLabel, 'Ativa');
  assert.equal(identity.ownerName, 'Ana Luiza Schapanski');
  assert.equal(identity.intendedOwnerName, null);
  assertNeverAwaitsFirstAccess(identity);
});

test('BÁRBARA materializada: titular ativa, proprietario Barbara, pretendido some', () => {
  const identity = barbaraIdentity({
    ownerUserId: BARBARA_AUTH,
    ownerName: 'Bárbara Steffen',
  });
  assert.equal(identity.holderAccountLabel, 'Ativa');
  assert.equal(identity.ownerName, 'Bárbara Steffen');
  assert.equal(identity.intendedOwnerName, null);
  assertNeverAwaitsFirstAccess(identity);
});

test('1. titular sem conta + owner null', () => {
  const unlinked = buildTicketIdentityView({
    holderName: 'João da Silva',
    holderContactUserId: null,
    ownerUserId: null,
    intendedOwnerContactId: JOAO_CADASTRO,
    intendedOwnerName: 'João da Silva',
  });
  assert.equal(unlinked.holderAccountKind, 'unlinked');
  assert.equal(unlinked.holderAccountLabel, 'Não vinculada');
  assert.equal(unlinked.ownerName, 'Não definido');

  const pendingInvite = buildTicketIdentityView({
    holderName: 'João da Silva',
    holderContactUserId: null,
    holderInviteStatus: 'pending',
    ownerUserId: null,
    intendedOwnerContactId: JOAO_CADASTRO,
    intendedOwnerName: 'João da Silva',
  });
  assert.equal(pendingInvite.holderAccountKind, 'pending_first_access');
  assert.equal(pendingInvite.holderAccountLabel, 'Aguardando primeiro acesso');
  assert.equal(pendingInvite.ownerName, 'Não definido');
});

test('2. titular com conta + owner null', () => {
  const identity = buildTicketIdentityView({
    holderName: 'Ana Luiza Schapanski',
    holderContactUserId: ANA_AUTH,
    ownerUserId: null,
  });
  assert.equal(identity.holderAccountLabel, 'Ativa');
  assert.equal(identity.ownerName, 'Não definido');
  assert.equal(identity.intendedOwnerName, null);
  assertNeverAwaitsFirstAccess(identity);
});

test('3. titular sem conta + owner Douglas', () => {
  const identity = buildTicketIdentityView({
    holderName: 'João da Silva',
    holderContactUserId: null,
    ownerUserId: DOUGLAS_AUTH,
    ownerName: 'Douglas',
  });
  assert.equal(identity.holderAccountLabel, 'Não vinculada');
  assert.equal(identity.ownerName, 'Douglas');
  assert.equal(identity.intendedOwnerName, null);
});

test('4. titular com conta + owner Douglas', () => {
  const identity = buildTicketIdentityView({
    holderName: 'João da Silva',
    holderContactUserId: 'auth-joao',
    ownerUserId: DOUGLAS_AUTH,
    ownerName: 'Douglas',
    intendedOwnerContactId: JOAO_CADASTRO,
    intendedOwnerName: 'João da Silva',
  });
  assert.equal(identity.holderName, 'João da Silva');
  assert.equal(identity.holderAccountLabel, 'Ativa');
  assert.equal(identity.ownerName, 'Douglas');
  assert.equal(identity.intendedOwnerName, null);
  assertNeverAwaitsFirstAccess(identity);
});

test('5. titular = owner', () => {
  const identity = buildTicketIdentityView({
    holderName: 'Ana Luiza Schapanski',
    holderContactUserId: ANA_AUTH,
    ownerUserId: ANA_AUTH,
    ownerName: 'Ana Luiza Schapanski',
    intendedOwnerContactId: ANA_CADASTRO,
    intendedOwnerName: 'Ana Luiza Schapanski',
  });
  assert.equal(identity.holderAccountLabel, 'Ativa');
  assert.equal(identity.ownerName, 'Ana Luiza Schapanski');
  assert.equal(identity.intendedOwnerName, null);
  assert.equal(
    contactTicketRoleLabel(rolesForContactTicket({
      ticketId: 't',
      eventId: 'e',
      eventName: 'Evento',
      ownerUserId: ANA_AUTH,
      intendedOwnerContactId: ANA_CADASTRO,
      orderItemContactId: ANA_CADASTRO,
    }, ANA_CADASTRO, [ANA_AUTH])),
    'Proprietário e titular',
  );
});

test('6. intended owner diferente do titular', () => {
  const identity = buildTicketIdentityView({
    holderName: 'João da Silva',
    holderContactUserId: null,
    ownerUserId: null,
    intendedOwnerContactId: ROBERTO_CADASTRO,
    intendedOwnerName: 'Roberto matias de arruda quarto',
  });
  assert.equal(identity.holderName, 'João da Silva');
  assert.equal(identity.holderAccountLabel, 'Não vinculada');
  assert.equal(identity.ownerName, 'Não definido');
  assert.equal(identity.intendedOwnerName, 'Roberto matias de arruda quarto');
});

test('7. intended owner com conta mas sem ownership', () => {
  const samePerson = anaIdentity();
  assert.equal(samePerson.holderAccountLabel, 'Ativa');
  assert.equal(samePerson.ownerName, 'Não definido');
  assert.equal(samePerson.intendedOwnerName, 'Ana Luiza Schapanski');
  assertNeverAwaitsFirstAccess(samePerson);

  const intendedOther = buildTicketIdentityView({
    holderName: 'João da Silva',
    holderContactUserId: null,
    ownerUserId: null,
    intendedOwnerContactId: ROBERTO_CADASTRO,
    intendedOwnerName: 'Roberto matias de arruda quarto',
  });
  assert.equal(intendedOther.holderAccountLabel, 'Não vinculada');
  assert.equal(intendedOther.ownerName, 'Não definido');
  assert.equal(intendedOther.intendedOwnerName, 'Roberto matias de arruda quarto');
  assert.doesNotMatch(intendedOther.ownerName, /aguardando/i);
});

test('8. ticket imported_holder nao muda titular/conta/proprietario', () => {
  const imported = anaIdentity({ buyerType: 'imported_holder' });
  const other = anaIdentity({ buyerType: 'account' });
  assert.deepEqual(imported, other);
});

test('9-10. status used/active nao muda titular/conta/proprietario', () => {
  const used = anaIdentity({ ticketStatus: 'used' });
  const active = anaIdentity({ ticketStatus: 'active' });
  assert.deepEqual(
    { holderAccountLabel: used.holderAccountLabel, ownerName: used.ownerName, intendedOwnerName: used.intendedOwnerName },
    { holderAccountLabel: active.holderAccountLabel, ownerName: active.ownerName, intendedOwnerName: active.intendedOwnerName },
  );
  assert.deepEqual(used, barbaraIdentity({
    holderName: 'Ana Luiza Schapanski',
    holderContactUserId: ANA_AUTH,
    intendedOwnerContactId: ANA_CADASTRO,
    intendedOwnerName: 'Ana Luiza Schapanski',
    ticketStatus: 'used',
  }));
});

test('owner_user_id null nunca e proxy de primeiro acesso se o cadastro ja tem conta', () => {
  const identity = buildTicketIdentityView({
    holderName: 'Ana Luiza Schapanski',
    holderContactUserId: ANA_AUTH,
    holderInviteStatus: 'claimed',
    ownerUserId: null,
    intendedOwnerContactId: ANA_CADASTRO,
    intendedOwnerName: 'Ana Luiza Schapanski',
  });
  assertNeverAwaitsFirstAccess(identity);
  assert.equal(identity.ownerName, 'Não definido');
});

test('papeis do cadastro nao carregam primeiro acesso', () => {
  assert.equal(contactTicketRoleLabel(['intended_owner', 'holder']), 'Titular');
  assert.equal(contactTicketRoleLabel(['intended_owner']), 'Pretendido');
  assert.equal(contactTicketRoleLabel(['owner']), 'Proprietário');
  assert.equal(contactTicketRoleLabel(['owner', 'holder']), 'Proprietário e titular');
  assert.equal(contactTicketRoleLabel(['holder']), 'Titular');
});
