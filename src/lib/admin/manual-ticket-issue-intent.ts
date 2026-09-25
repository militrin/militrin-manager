export type ManualTicketIssueIntent = {
  assignHolder: boolean;
  acknowledgeExisting: boolean;
};

export function initialManualTicketIssueIntent(): ManualTicketIssueIntent {
  return { assignHolder: true, acknowledgeExisting: false };
}

export function intentAfterEmitWithoutHolder(): ManualTicketIssueIntent {
  return { assignHolder: false, acknowledgeExisting: false };
}

export function intentAfterAcknowledgeExisting(previousAssignHolder: boolean): ManualTicketIssueIntent {
  return {
    assignHolder: previousAssignHolder,
    acknowledgeExisting: true,
  };
}

export function holderAlreadyAssignedMessage() {
  return "Esta pessoa já é titular de outro ingresso neste evento.";
}

export function buildExistingOperationalTicketWarning(ticketCode?: string | null) {
  const code = String(ticketCode ?? "").trim();
  const existingLine = code ? `Ingresso existente: ${code}.\n` : "";
  return (
    "Esta pessoa já possui um ingresso ativo/usado para este evento.\n" +
    existingLine +
    "Isso é uma proteção contra emissão duplicada acidental.\n" +
    "Deseja realmente criar OUTRO ingresso para este cadastro?"
  );
}
