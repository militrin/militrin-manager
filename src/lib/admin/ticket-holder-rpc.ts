import { validateSensitiveActionReason } from "./sensitive-action-reasons.ts";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HOLDER_NAME_LENGTH = 200;

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

export function buildAdminSetTicketHolderNamePayload(
  ticketId: string,
  holderName: string,
  reasonCode?: string | null,
  reasonText?: string | null,
) {
  if (!uuidPattern.test(ticketId)) throw new Error("Ingresso inválido.");
  const name = holderName.trim();
  if (!name) throw new Error("Informe o nome do titular.");
  if (name.length > MAX_HOLDER_NAME_LENGTH) throw new Error("Nome do titular excede o limite.");
  const reason = reasonCode
    ? validateSensitiveActionReason(reasonCode, reasonText)
    : { reasonCode: "administrative_adjustment" as const, reasonText: reasonText?.trim() || null };
  return {
    p_ticket_id: ticketId,
    p_holder_name: name,
    p_reason_code: reason.reasonCode,
    p_reason_text: reason.reasonText,
  };
}

export function buildAdminClearTicketHolderNamePayload(
  ticketId: string,
  reasonCode: string,
  reasonText?: string | null,
) {
  if (!uuidPattern.test(ticketId)) throw new Error("Ingresso inválido.");
  const reason = validateSensitiveActionReason(reasonCode, reasonText);
  return {
    p_ticket_id: ticketId,
    p_holder_name: null as string | null,
    p_reason_code: reason.reasonCode,
    p_reason_text: reason.reasonText,
  };
}
