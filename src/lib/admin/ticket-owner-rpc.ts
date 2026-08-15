import { validateSensitiveActionReason } from "./sensitive-action-reasons.ts";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TICKET_OWNER_HOLDER_ACTIONS = ["keep", "assign_new_owner", "remove"] as const;
export type TicketOwnerHolderAction = (typeof TICKET_OWNER_HOLDER_ACTIONS)[number];

export function buildAdminTransferTicketOwnershipPayload(input: {
  ticketId: string;
  expectedOwnerUserId: string | null;
  newOwnerUserId: string;
  holderAction: TicketOwnerHolderAction;
  reasonCode: string;
  reasonText?: string | null;
}) {
  if (!uuidPattern.test(input.ticketId)) throw new Error("Ingresso inválido.");
  if (!uuidPattern.test(input.newOwnerUserId)) throw new Error("Selecione uma conta NEXORA válida.");
  if(input.expectedOwnerUserId!==null&&!uuidPattern.test(input.expectedOwnerUserId)) throw new Error("Proprietário atual inválido.");
  if (!TICKET_OWNER_HOLDER_ACTIONS.includes(input.holderAction)) throw new Error("Escolha o tratamento do titular.");
  const reason = validateSensitiveActionReason(input.reasonCode, input.reasonText);
  return {
    p_ticket_id: input.ticketId,
    p_expected_owner_user_id: input.expectedOwnerUserId,
    p_new_owner_user_id: input.newOwnerUserId,
    p_holder_action: input.holderAction,
    p_reason_code: reason.reasonCode,
    p_reason_text: reason.reasonText,
  };
}
