export const SENSITIVE_ACTION_REASON_OPTIONS = [
  { code: "registration_correction", label: "Correção de cadastro" },
  { code: "buyer_request", label: "Solicitação do comprador" },
  { code: "holder_request", label: "Solicitação do titular" },
  { code: "third_party_ticket", label: "Ingresso para terceiro" },
  { code: "administrative_adjustment", label: "Cortesia / ajuste administrativo" },
  { code: "issuance_error", label: "Erro de emissão" },
  { code: "system_error", label: "Falha do sistema" },
  { code: "data_regularization", label: "Regularização de dados" },
  { code: "other", label: "Outro" },
] as const;

export type SensitiveActionReasonCode = typeof SENSITIVE_ACTION_REASON_OPTIONS[number]["code"];

const labels = new Map<string,string>([
  ...SENSITIVE_ACTION_REASON_OPTIONS.map((item) => [item.code,item.label] as const),
  ["legacy_unclassified","Motivo legado não classificado"],
]);

export function sensitiveActionReasonLabel(code: string | null | undefined) {
  return code ? labels.get(code) ?? "Motivo não reconhecido" : null;
}

export function isSensitiveActionReasonCode(value: string): value is SensitiveActionReasonCode {
  return SENSITIVE_ACTION_REASON_OPTIONS.some((item) => item.code === value);
}

export function validateSensitiveActionReason(code: string, text?: string | null) {
  if (!isSensitiveActionReasonCode(code)) throw new Error("Selecione um motivo válido.");
  const normalizedText = text?.trim() || null;
  if (code === "other" && !normalizedText) throw new Error("Descreva o motivo da alteração.");
  return { reasonCode: code, reasonText: normalizedText };
}
