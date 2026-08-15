import { validateSensitiveActionReason } from "./sensitive-action-reasons.ts";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildAdminSetTicketHolderPayload(
  ticketId:string,
  registrationContactId:string|null|undefined,
  reasonCode:string,
  reasonText?:string|null,
) {
  if(!uuidPattern.test(ticketId)) throw new Error("Ingresso inválido.");
  if(registrationContactId===undefined) throw new Error("Selecione um cadastro válido ou remova o titular explicitamente.");
  if(registrationContactId!==null&&!uuidPattern.test(registrationContactId)) throw new Error("Cadastro de titular inválido.");
  const reason=validateSensitiveActionReason(reasonCode,reasonText);
  return {p_ticket_id:ticketId,p_registration_contact_id:registrationContactId,p_reason_code:reason.reasonCode,p_reason_text:reason.reasonText};
}
