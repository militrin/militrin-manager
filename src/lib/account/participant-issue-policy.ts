export const REQUIRED_PARTICIPANT_FIELD_CODES = [
  'full_name', 'cpf', 'birth_date', 'phone', 'email', 'city',
] as const;
export const REQUIRED_PARTICIPANT_FIELDS = new Set<string>(REQUIRED_PARTICIPANT_FIELD_CODES);

export type ParticipantIssuePolicyRow = {
  resolution_scope?: string | null;
  field_code?: string | null;
  blocks_payment?: boolean | null;
  blocks_ticket_issuance?: boolean | null;
  blocks_checkin?: boolean | null;
  blocks_kit_delivery?: boolean | null;
};

export function isRequiredUserResolvableIssue(issue: ParticipantIssuePolicyRow) {
  return issue.resolution_scope === 'user_resolvable'
    && REQUIRED_PARTICIPANT_FIELDS.has(String(issue.field_code ?? ''));
}

export function isAdministrativeIssue(issue: ParticipantIssuePolicyRow) {
  return issue.resolution_scope !== 'user_resolvable';
}

export function getParticipantOperationBlocks(issues: ParticipantIssuePolicyRow[]) {
  return {
    payment: issues.some((issue) => Boolean(issue.blocks_payment)),
    ticketIssuance: issues.some((issue) => Boolean(issue.blocks_ticket_issuance)),
    checkin: issues.some((issue) => Boolean(issue.blocks_checkin)),
    kitDelivery: issues.some((issue) => Boolean(issue.blocks_kit_delivery)),
  };
}
