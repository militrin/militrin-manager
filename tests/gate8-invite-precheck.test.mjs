import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GATE5_HISTORICAL_BASELINE,
  ROBERTO_ADMIN_CORRECTION,
  activeTicketCount,
  emailHasCoherentInviteAccess,
  evaluateGate8Precheck,
  evaluateRobertoAdminCorrection,
  historicalOfficialTicketCount,
  recipientHasCoherentAccess,
  shouldBlockEmailFromInviteJob,
  singleLoginCanMaterializeGroup,
} from '../src/lib/account/gate8-invite-precheck.ts';

const robertoPeople = [
  { id: ROBERTO_ADMIN_CORRECTION.keptRobertoContactId, pin: '0CC90AB8C9', gender: 'male' },
  { id: ROBERTO_ADMIN_CORRECTION.supersededContactId, pin: 'CBE5203AFF', gender: 'male' },
  { id: ROBERTO_ADMIN_CORRECTION.femaleContactId, pin: 'BC118A04A3', gender: 'Feminino' },
];

const robertoTickets = [
  {
    id: ROBERTO_ADMIN_CORRECTION.keptTicketId,
    status: 'active',
    holderContactId: ROBERTO_ADMIN_CORRECTION.keptRobertoContactId,
    intendedOwnerContactId: ROBERTO_ADMIN_CORRECTION.keptRobertoContactId,
  },
  {
    id: ROBERTO_ADMIN_CORRECTION.cancelledTicketId,
    status: 'cancelled',
    holderContactId: ROBERTO_ADMIN_CORRECTION.supersededContactId,
    intendedOwnerContactId: ROBERTO_ADMIN_CORRECTION.keptRobertoContactId,
  },
  {
    id: ROBERTO_ADMIN_CORRECTION.correctiveTicketId,
    status: 'active',
    holderContactId: ROBERTO_ADMIN_CORRECTION.supersededContactId,
    intendedOwnerContactId: ROBERTO_ADMIN_CORRECTION.femaleContactId,
  },
];

test('Gate #5 histórico continua 487/487/467 e não exige 487 tickets ativos', () => {
  assert.equal(GATE5_HISTORICAL_BASELINE.officialPeople, 487);
  assert.equal(GATE5_HISTORICAL_BASELINE.officialHistoricalTickets, 487);
  assert.equal(GATE5_HISTORICAL_BASELINE.uniqueEmails, 467);
  const historical = historicalOfficialTicketCount(
    [{ participantId: 'a' }, { participantId: 'b' }, { participantId: 'c' }],
    ['a', 'b'],
  );
  assert.equal(historical, 2);
  assert.equal(activeTicketCount([{ status: 'active' }, { status: 'cancelled' }, { status: 'active' }]), 2);
  const precheck = evaluateGate8Precheck({
    officialPeople: 487,
    officialHistoricalTickets: 487,
    uniqueEmails: 467,
    sharedGroups: 18,
    officialActiveTickets: 486,
    officialInvitesSent: 0,
    officialOwnerUserIds: 0,
    authConflicts: 0,
    robertoClassification: 'LEGITIMATE',
    inviteRecipients: [{ email: 'a@x.com', hasCoherentAccess: true }],
  });
  assert.equal(precheck.ok, true);
  assert.equal(precheck.requireActiveOfficialTickets, false);
  assert.equal(precheck.roberto, 'LEGITIMATE');
});

test('correção administrativa do Roberto é legítima e não ressuscita o cancelado', () => {
  const result = evaluateRobertoAdminCorrection({
    people: robertoPeople,
    tickets: robertoTickets,
    kits: [
      { ticketId: ROBERTO_ADMIN_CORRECTION.keptTicketId, status: 'reserved', shirt: 'Camiseta M' },
      { ticketId: ROBERTO_ADMIN_CORRECTION.cancelledTicketId, status: 'cancelled', shirt: 'Camiseta GG' },
      { ticketId: ROBERTO_ADMIN_CORRECTION.correctiveTicketId, status: 'confirmed', shirt: 'Camiseta GG' },
    ],
  });
  assert.equal(result.classification, 'LEGITIMATE');
  assert.equal(result.checks.twoOperationalAccesses, true);
  assert.equal(result.checks.robertoKeepsTicket, true);
  assert.equal(result.checks.femaleOwnsCorrectedTicket, true);
  assert.equal(result.checks.femalePinMatches, true);
  assert.equal(result.checks.noThirdActiveTicket, true);
  assert.equal(result.checks.historyPreserved, true);
  assert.equal(result.checks.cancelledNotResurrected, true);
  assert.deepEqual(result.activeTicketIds.sort(), [
    ROBERTO_ADMIN_CORRECTION.correctiveTicketId,
    ROBERTO_ADMIN_CORRECTION.keptTicketId,
  ].sort());
});

test('destinatário de convite precisa de acesso atual, não do ticket cancelado', () => {
  assert.equal(recipientHasCoherentAccess({
    contactId: ROBERTO_ADMIN_CORRECTION.femaleContactId,
    activeTickets: robertoTickets.filter((ticket) => ticket.status === 'active'),
  }), true);
  assert.equal(recipientHasCoherentAccess({
    contactId: ROBERTO_ADMIN_CORRECTION.femaleContactId,
    activeTickets: robertoTickets.filter((ticket) => ticket.id === ROBERTO_ADMIN_CORRECTION.cancelledTicketId),
  }), false);
  assert.equal(emailHasCoherentInviteAccess(robertoTickets.filter((ticket) => ticket.status === 'active')), true);
});

test('Roberto: um login não cobre os dois intended_owners; bloquear só esse e-mail', () => {
  const active = robertoTickets.filter((ticket) => ticket.status === 'active');
  assert.equal(singleLoginCanMaterializeGroup(active), false);
  const blocked = shouldBlockEmailFromInviteJob(ROBERTO_ADMIN_CORRECTION.email, active);
  assert.equal(blocked.block, true);
  assert.equal(shouldBlockEmailFromInviteJob('alineherbert385@gmail.com', [
    { intendedOwnerContactId: 'aline' },
    { intendedOwnerContactId: 'aline' },
  ]).block, false);
});

test('precheck bloqueia se a correção do Roberto estiver incoerente', () => {
  const broken = evaluateRobertoAdminCorrection({
    people: robertoPeople,
    tickets: robertoTickets.map((ticket) => ticket.id === ROBERTO_ADMIN_CORRECTION.cancelledTicketId ? { ...ticket, status: 'active' } : ticket),
    kits: [
      { ticketId: ROBERTO_ADMIN_CORRECTION.keptTicketId, status: 'reserved', shirt: 'Camiseta M' },
      { ticketId: ROBERTO_ADMIN_CORRECTION.cancelledTicketId, status: 'reserved', shirt: 'Camiseta GG' },
      { ticketId: ROBERTO_ADMIN_CORRECTION.correctiveTicketId, status: 'confirmed', shirt: 'Camiseta GG' },
    ],
  });
  assert.equal(broken.classification, 'BLOCK');
  const precheck = evaluateGate8Precheck({
    officialPeople: 487,
    officialHistoricalTickets: 487,
    uniqueEmails: 467,
    sharedGroups: 18,
    officialActiveTickets: 486,
    officialInvitesSent: 0,
    officialOwnerUserIds: 0,
    authConflicts: 0,
    robertoClassification: 'BLOCK',
    inviteRecipients: [{ email: 'a@x.com', hasCoherentAccess: true }],
  });
  assert.equal(precheck.ok, false);
});
