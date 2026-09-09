export type IssuanceIssue = {
  issue_type?: string | null;
  message?: string | null;
  blocks_ticket_issuance?: boolean | null;
  status?: string | null;
};

function isOpenIssue(issue: IssuanceIssue) {
  return issue.status == null || issue.status === 'open';
}

/**
 * legacy_unknown nunca e issuance blocker: preco historico ausente preserva
 * a compra e nao explica a ausencia do ticket.
 */
export function openIssuanceBlockers(issues: IssuanceIssue[]) {
  return issues.filter((issue) =>
    Boolean(issue.blocks_ticket_issuance)
    && isOpenIssue(issue)
    && issue.issue_type !== 'legacy_unknown',
  );
}

export function formatIssuanceBlockerMessages(issues: IssuanceIssue[]) {
  return openIssuanceBlockers(issues).map((issue) => {
    const message = String(issue.message ?? '').trim();
    if (issue.issue_type === 'underage_at_event') {
      return message || 'Pessoa menor de 18 anos na data do evento';
    }
    return message || issue.issue_type || 'Pendência que impede a emissão do ingresso';
  }).filter(Boolean);
}

export function formatImportedPurchaseWithoutTicketCopy(input: {
  eventName: string;
  blockerMessages: string[];
}) {
  if (input.blockerMessages.length) {
    return `${input.eventName} · o ingresso ainda não foi emitido. Motivo: ${input.blockerMessages.join(' · ')}`;
  }
  return `${input.eventName} · o ingresso ainda não foi emitido.`;
}

export function additionalTicketHolderUnassignedCopy() {
  return 'Ingresso adicional da mesma pessoa neste evento. Titular não definido porque a regra permite apenas um titular por pessoa por evento.';
}

export function countIssuedTickets(items: Array<{ ticketId?: string | null; ticketStatus?: string | null }>) {
  return items.filter((item) =>
    Boolean(item.ticketId)
    && Boolean(item.ticketStatus)
    && item.ticketStatus !== 'cancelled',
  ).length;
}
