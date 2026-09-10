export const GATE5_HISTORICAL_BASELINE = {
  officialPeople: 487,
  officialHistoricalTickets: 487,
  uniqueEmails: 467,
  sharedGroups: 18,
} as const;

export const ROBERTO_ADMIN_CORRECTION = {
  email: 'robertomatiasquarto410@gmail.com',
  keptRobertoContactId: '7e9dacaa-e620-4d2b-92cd-3e691f67f768',
  keptRobertoPin: '0CC90AB8C9',
  supersededContactId: '0acd0a8c-963c-4753-853f-aa48e67d0d1d',
  supersededPin: 'CBE5203AFF',
  femaleContactId: '7b698905-150a-416a-bd27-15d767fdfcab',
  femalePin: 'BC118A04A3',
  keptTicketId: 'dc8fe02d-bcc7-4943-8c54-659371da5ef2',
  cancelledTicketId: 'af7c4988-0076-4f05-9e55-a164d5031b23',
  correctiveTicketId: '24bd5085-228b-4e75-90a1-d02fc2745379',
} as const;

const CANCELLED = new Set(['cancelled', 'canceled', 'void', 'voided']);

export function isActiveTicketStatus(status: string | null | undefined) {
  return !CANCELLED.has(String(status ?? '').toLowerCase());
}

export function historicalOfficialTicketCount(tickets: Array<{ participantId?: string | null }>, officialParticipantIds: Iterable<string>) {
  const official = new Set([...officialParticipantIds].map(String));
  return tickets.filter((ticket) => official.has(String(ticket.participantId ?? ''))).length;
}

export function activeTicketCount(tickets: Array<{ status?: string | null }>) {
  return tickets.filter((ticket) => isActiveTicketStatus(ticket.status)).length;
}

export function recipientHasCoherentAccess(input: {
  contactId: string;
  activeTickets: Array<{
    holderContactId?: string | null;
    intendedOwnerContactId?: string | null;
  }>;
}) {
  return input.activeTickets.some((ticket) => {
    const holder = String(ticket.holderContactId ?? '').trim();
    const owner = String(ticket.intendedOwnerContactId ?? '').trim();
    return holder === input.contactId || owner === input.contactId;
  });
}

export function evaluateRobertoAdminCorrection(input: {
  people: Array<{ id: string; pin?: string | null; gender?: string | null }>;
  tickets: Array<{
    id: string;
    status?: string | null;
    intendedOwnerContactId?: string | null;
    holderContactId?: string | null;
  }>;
  kits: Array<{ ticketId?: string | null; status?: string | null; shirt?: string | null }>;
}) {
  const ids = new Set(input.people.map((person) => person.id));
  const female = input.people.find((person) => person.id === ROBERTO_ADMIN_CORRECTION.femaleContactId);
  const kept = input.tickets.find((ticket) => ticket.id === ROBERTO_ADMIN_CORRECTION.keptTicketId);
  const cancelled = input.tickets.find((ticket) => ticket.id === ROBERTO_ADMIN_CORRECTION.cancelledTicketId);
  const corrective = input.tickets.find((ticket) => ticket.id === ROBERTO_ADMIN_CORRECTION.correctiveTicketId);
  const groupTickets = input.tickets.filter((ticket) => {
    const holder = String(ticket.holderContactId ?? '');
    const owner = String(ticket.intendedOwnerContactId ?? '');
    return ids.has(holder) || ids.has(owner) || [
      ROBERTO_ADMIN_CORRECTION.keptTicketId,
      ROBERTO_ADMIN_CORRECTION.cancelledTicketId,
      ROBERTO_ADMIN_CORRECTION.correctiveTicketId,
    ].includes(ticket.id as typeof ROBERTO_ADMIN_CORRECTION.keptTicketId);
  });
  const active = groupTickets.filter((ticket) => isActiveTicketStatus(ticket.status));
  const activeShirts = input.kits.filter((kit) => isActiveTicketStatus(kit.status) && /camiseta/i.test(String(kit.shirt ?? 'camiseta')));
  const checks = {
    twoOperationalAccesses: active.length === 2,
    robertoKeepsTicket: Boolean(
      kept && isActiveTicketStatus(kept.status)
      && (kept.holderContactId === ROBERTO_ADMIN_CORRECTION.keptRobertoContactId
        || kept.intendedOwnerContactId === ROBERTO_ADMIN_CORRECTION.keptRobertoContactId),
    ),
    femaleOwnsCorrectedTicket: Boolean(
      corrective && isActiveTicketStatus(corrective.status)
      && corrective.intendedOwnerContactId === ROBERTO_ADMIN_CORRECTION.femaleContactId,
    ),
    femalePinMatches: Boolean(female && String(female.pin ?? '').toUpperCase() === ROBERTO_ADMIN_CORRECTION.femalePin),
    femaleGender: Boolean(female && /feminin/i.test(String(female.gender ?? ''))),
    noThirdActiveTicket: active.length === 2
      && !active.some((ticket) => ticket.id === ROBERTO_ADMIN_CORRECTION.cancelledTicketId),
    kitReflectsTwoAccesses: activeShirts.length === 2,
    historyPreserved: Boolean(
      cancelled && !isActiveTicketStatus(cancelled.status)
      && corrective && isActiveTicketStatus(corrective.status)
      && cancelled.id !== corrective.id,
    ),
    cancelledNotResurrected: Boolean(cancelled && !isActiveTicketStatus(cancelled.status)),
  };
  return {
    classification: Object.values(checks).every(Boolean) ? 'LEGITIMATE' as const : 'BLOCK' as const,
    checks,
    activeTicketIds: active.map((ticket) => ticket.id),
  };
}

export function evaluateGate8Precheck(input: {
  officialPeople: number;
  officialHistoricalTickets: number;
  uniqueEmails: number;
  sharedGroups: number;
  officialActiveTickets?: number;
  officialInvitesSent: number;
  officialOwnerUserIds: number;
  authConflicts: number;
  robertoClassification: 'LEGITIMATE' | 'BLOCK';
  inviteRecipients: Array<{ email: string; hasCoherentAccess: boolean }>;
}) {
  const historical = {
    officialPeople: input.officialPeople === GATE5_HISTORICAL_BASELINE.officialPeople,
    officialHistoricalTickets: input.officialHistoricalTickets === GATE5_HISTORICAL_BASELINE.officialHistoricalTickets,
    uniqueEmails: input.uniqueEmails === GATE5_HISTORICAL_BASELINE.uniqueEmails,
    sharedGroups: input.sharedGroups === GATE5_HISTORICAL_BASELINE.sharedGroups,
  };
  const blockers = [
    !historical.officialPeople ? 'Pessoas oficiais do lote divergem de 487' : null,
    !historical.officialHistoricalTickets ? 'Tickets históricos do lote divergem de 487' : null,
    !historical.uniqueEmails ? 'E-mails únicos/convites previstos divergem de 467' : null,
    input.officialInvitesSent !== 0 ? 'Já existem convites oficiais enviados' : null,
    input.officialOwnerUserIds !== 0 ? 'Há owner_user_id materializado em ticket oficial' : null,
    input.authConflicts !== 0 ? 'Há conflito Auth conhecido' : null,
    input.robertoClassification !== 'LEGITIMATE' ? 'Correção administrativa do Roberto não está coerente' : null,
    input.inviteRecipients.some((row) => !row.hasCoherentAccess) ? 'Há destinatário de convite sem acesso operacional coerente' : null,
  ].filter(Boolean);
  return {
    ok: blockers.length === 0,
    requireActiveOfficialTickets: false,
    officialActiveTicketsIgnored: input.officialActiveTickets ?? null,
    historical,
    roberto: input.robertoClassification,
    blockers,
    inviteRecipients: input.inviteRecipients.length,
  };
}

export function emailHasCoherentInviteAccess(activeTickets: Array<{ holderContactId?: string | null; intendedOwnerContactId?: string | null }>) {
  return activeTickets.some((ticket) => String(ticket.holderContactId ?? '').trim() || String(ticket.intendedOwnerContactId ?? '').trim());
}

export function distinctIntendedOwners(activeTickets: Array<{ intendedOwnerContactId?: string | null }>) {
  return [...new Set(activeTickets.map((ticket) => String(ticket.intendedOwnerContactId ?? '').trim()).filter(Boolean))];
}

export function singleLoginCanMaterializeGroup(activeTickets: Array<{ intendedOwnerContactId?: string | null }>) {
  return distinctIntendedOwners(activeTickets).length <= 1;
}

export function shouldBlockEmailFromInviteJob(email: string, activeTickets: Array<{ intendedOwnerContactId?: string | null }>) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (normalized === ROBERTO_ADMIN_CORRECTION.email && !singleLoginCanMaterializeGroup(activeTickets)) {
    return {
      block: true as const,
      reason: 'mixed_intended_owner_single_login',
      message: 'Um único login não materializa os dois ingressos sem alterar intended_owner ou perder um acesso.',
    };
  }
  if (!singleLoginCanMaterializeGroup(activeTickets)) {
    return {
      block: true as const,
      reason: 'mixed_intended_owner_single_login',
      message: 'intended_owner distinto em ingressos ativos do mesmo e-mail.',
    };
  }
  return { block: false as const, reason: null, message: null };
}
