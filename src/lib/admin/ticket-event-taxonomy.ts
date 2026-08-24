export type TimelineScope = "ticket" | "account";
export type TimelineCategory = "ingresso" | "pagamento" | "titularidade" | "propriedade" | "categoria" | "camiseta" | "checkin" | "kit" | "comunicacao" | "cancelamento" | "cadastro" | "acesso" | "pendencia";

export type TimelineActionDefinition = {
  label: string;
  description: string;
  category: TimelineCategory;
  scopes: TimelineScope[];
  previousKeys?: string[];
  nextKeys?: string[];
};

const ticketAndAccount: TimelineScope[] = ["ticket", "account"];
const accountOnly: TimelineScope[] = ["account"];

export const TICKET_EVENT_TAXONOMY: Record<string, TimelineActionDefinition> = {
  ticket_issued: { label: "Ingresso emitido", description: "O ingresso foi emitido.", category: "ingresso", scopes: ticketAndAccount },
  payment_confirmed: { label: "Pagamento confirmado", description: "O pagamento associado foi confirmado.", category: "pagamento", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status", "payment_status"] },
  payment_admin_confirmed: { label: "Pagamento confirmado", description: "O pagamento associado foi confirmado administrativamente.", category: "pagamento", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status", "payment_status"] },
  registration_payment_confirmed: { label: "Pagamento confirmado", description: "O pagamento da inscrição foi confirmado.", category: "pagamento", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status", "payment_status"] },
  ticket_shirt_admin_changed: { label: "Camiseta alterada", description: "A camiseta vinculada ao ingresso foi alterada.", category: "camiseta", scopes: ticketAndAccount, previousKeys: ["previous_variant_id"], nextKeys: ["new_variant_id", "variant_id"] },
  ticket_shirt_changed: { label: "Camiseta alterada", description: "A camiseta vinculada ao ingresso foi alterada.", category: "camiseta", scopes: ticketAndAccount, previousKeys: ["previous_type", "previous_size"], nextKeys: ["next_type", "next_size"] },
  ticket_category_changed: { label: "Categoria alterada", description: "A categoria do ingresso foi alterada.", category: "categoria", scopes: ticketAndAccount, previousKeys: ["previous_category_id"], nextKeys: ["ticket_category_id", "new_category_id"] },
  ticket_holder_assigned: { label: "Titular definido", description: "Um titular foi definido para o ingresso.", category: "titularidade", scopes: ticketAndAccount, previousKeys: ["previous_participant_id"], nextKeys: ["new_participant_id"] },
  holder_assigned: { label: "Titular definido", description: "Um titular foi definido para o ingresso.", category: "titularidade", scopes: ticketAndAccount, previousKeys: ["previous_participant_id"], nextKeys: ["new_participant_id"] },
  holder_changed: { label: "Titular alterado", description: "A titularidade do ingresso foi alterada.", category: "titularidade", scopes: ticketAndAccount, previousKeys: ["previous_participant_id"], nextKeys: ["new_participant_id"] },
  ticket_transferred: { label: "Titularidade transferida", description: "A titularidade do ingresso foi transferida.", category: "titularidade", scopes: ticketAndAccount, previousKeys: ["previous_participant_id", "previous_user_id"], nextKeys: ["new_participant_id", "new_user_id"] },
  holder_removed: { label: "Titular removido", description: "O ingresso ficou sem titular.", category: "titularidade", scopes: ticketAndAccount, previousKeys: ["previous_registration_contact_id", "previous_participant_id"], nextKeys: [] },
  owner_assigned: { label: "Proprietário definido", description: "Uma conta proprietária foi definida para o ingresso.", category: "propriedade", scopes: ticketAndAccount, previousKeys: ["previous_owner_user_id"], nextKeys: ["new_owner_user_id"] },
  owner_transferred: { label: "Propriedade transferida", description: "A conta proprietária atual do ingresso foi alterada.", category: "propriedade", scopes: ticketAndAccount, previousKeys: ["previous_owner_user_id"], nextKeys: ["new_owner_user_id"] },
  admin_ticket_holder_transferred: { label: "Titularidade transferida", description: "A titularidade do ingresso foi transferida administrativamente.", category: "titularidade", scopes: ticketAndAccount, previousKeys: ["previous_participant_id"], nextKeys: ["new_participant_id"] },
  ticket_kit_item_delivered: { label: "Item do kit entregue", description: "Um item do kit foi entregue.", category: "kit", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status"] },
  ticket_kit_item_delivery_undone: { label: "Entrega de item desfeita", description: "A entrega de um item do kit foi desfeita.", category: "kit", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status"] },
  ticket_checkin_entry: { label: "Check-in realizado", description: "O ingresso foi utilizado no check-in.", category: "checkin", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status"] },
  participant_checkin_entry: { label: "Check-in realizado", description: "O participante realizou check-in.", category: "checkin", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status"] },
  ticket_checkin_undo: { label: "Check-in desfeito", description: "O check-in do ingresso foi desfeito.", category: "checkin", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status"] },
  ticket_resent: { label: "Ingresso reenviado", description: "O ingresso foi reenviado ao destinatário autorizado.", category: "comunicacao", scopes: ticketAndAccount },
  admin_ticket_cancelled: { label: "Ingresso cancelado", description: "O ingresso foi cancelado administrativamente.", category: "cancelamento", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status"] },
  ticket_item_change_requested: { label: "Alteração de item solicitada", description: "Foi solicitada uma alteração de item do ingresso.", category: "kit", scopes: ticketAndAccount },
  ticket_item_change_approved: { label: "Alteração de item aprovada", description: "A alteração de item foi aprovada.", category: "kit", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status"] },
  ticket_item_change_rejected: { label: "Alteração de item rejeitada", description: "A alteração de item foi rejeitada.", category: "kit", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status"] },
  participant_data_issues_reevaluated: { label: "Pendências cadastrais reavaliadas", description: "As pendências cadastrais do participante foram reavaliadas.", category: "pendencia", scopes: accountOnly, previousKeys: ["previous_open_issue_count"], nextKeys: ["open_issue_count"] },
  participant_account_invite_claimed: { label: "Primeiro acesso confirmado", description: "O convite de primeiro acesso foi reivindicado pela conta autorizada.", category: "acesso", scopes: accountOnly },
  imported_participant_issue_finalized: { label: "Finalização do cadastro importado", description: "A etapa de resolução das pendências do cadastro importado foi finalizada.", category: "cadastro", scopes: accountOnly, previousKeys: ["previous_status"], nextKeys: ["finalization", "new_status"] },
  ticket_history_exported: { label: "Histórico exportado", description: "O histórico administrativo foi exportado.", category: "comunicacao", scopes: accountOnly },
  manual_ticket_issued: { label: "Ingresso emitido manualmente", description: "O ingresso foi emitido administrativamente (cortesia, correção ou falha de sistema).", category: "ingresso", scopes: ticketAndAccount },
  manual_registration_order_created: { label: "Ingresso emitido manualmente", description: "O pedido/ingresso foi criado administrativamente a partir de um cadastro.", category: "ingresso", scopes: ticketAndAccount },
  combined_kit_delivery_and_checkin: { label: "Kit entregue + check-in", description: "O kit foi entregue e o check-in realizado em uma única operação.", category: "kit", scopes: ticketAndAccount, previousKeys: ["previous_status"], nextKeys: ["new_status"] },
  ticket_shirt_admin_corrected_after_operation: { label: "Camiseta corrigida", description: "A camiseta foi corrigida administrativamente após entrega ou check-in.", category: "camiseta", scopes: ticketAndAccount, previousKeys: ["previous_variant_id"], nextKeys: ["new_variant_id", "variant_id"] },
  wristband_linked: { label: "Pulseira vinculada", description: "Uma pulseira foi vinculada ao ingresso.", category: "kit", scopes: ticketAndAccount },
  wristband_unlinked: { label: "Pulseira desvinculada", description: "A pulseira foi desvinculada do ingresso.", category: "kit", scopes: ticketAndAccount },
  wristband_blocked: { label: "Pulseira bloqueada", description: "A pulseira foi bloqueada.", category: "kit", scopes: ticketAndAccount },
  store_order_item_delivered: { label: "Item adicional entregue", description: "Um item adicional (loja) foi entregue.", category: "kit", scopes: ticketAndAccount },
  store_order_item_delivery_undone: { label: "Entrega de item adicional desfeita", description: "A entrega de um item adicional (loja) foi desfeita.", category: "kit", scopes: ticketAndAccount },
  store_item_admin_granted: { label: "Item adicional concedido", description: "Um item adicional (loja) foi concedido administrativamente.", category: "kit", scopes: ticketAndAccount },
};

export function timelineActionDefinition(action: string) {
  return TICKET_EVENT_TAXONOMY[action] ?? null;
}

export type TimelineTypeOption = { code: string; label: string; technical?: boolean };

export function timelineTypeOptions(codes: string[], includeTechnical = false): TimelineTypeOption[] {
  const known: TimelineTypeOption[] = [...new Set(codes)].flatMap((code) => {
    const definition = timelineActionDefinition(code);
    return definition ? [{ code, label: definition.label }] : [];
  });
  known.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR') || a.code.localeCompare(b.code));
  if (includeTechnical) known.push({ code: '__technical__', label: 'Outros registros técnicos', technical: true });
  return known;
}
