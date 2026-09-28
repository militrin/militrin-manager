const OFF_GATEWAY_ERROR_MESSAGES: Record<string, string> = {
  METHOD_INVALID: "Nesta versão só é permitido PIX fora do gateway.",
  AMOUNT_RECEIVED_INVALID: "O valor recebido deve ser maior que zero.",
  RECEIVED_AT_REQUIRED: "Informe a data e hora reais do recebimento.",
  REASON_REQUIRED: "O motivo é obrigatório.",
  PAYMENT_NOT_FOUND: "Pagamento não encontrado.",
  GATEWAY_LIVE_PAYMENT: "Este pagamento tem cobrança no gateway integrado e não pode ser convertido para fora do gateway.",
  COUPON_ZERO_NOT_OFF_GATEWAY: "Cupom 100% não é pagamento recebido fora do gateway.",
  PENDING_OFF_GATEWAY_NOT_IMPLEMENTED: "Regularização fora do gateway nesta versão só se aplica a pagamento já pago, sem emitir ingresso.",
  OFF_GATEWAY_ALREADY_RECORDED: "Este pagamento já possui regularização fora do gateway. Confirme a substituição explícita.",
};

const TECHNICAL_LEAK = /\b(postgres|sqlstate|constraint|violat|stack|plpgsql|asaas\.com|relation |column |rpc\b)/i;

export function humanizeOffGatewayError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return "Não foi possível registrar o pagamento fora do gateway.";

  const code = trimmed.split(":")[0]?.trim().toUpperCase() ?? "";
  if (OFF_GATEWAY_ERROR_MESSAGES[code]) return OFF_GATEWAY_ERROR_MESSAGES[code];

  const lower = trimmed.toLowerCase();
  if (lower.includes("sem permiss")) return "Sem permissão para registrar pagamento fora do gateway.";
  if (lower.includes("nao autenticado") || lower.includes("não autenticado")) {
    return "Sua sessão expirou. Entre novamente para registrar o pagamento.";
  }
  if (lower.includes("sem acesso a organizacao") || lower.includes("sem acesso à organização")) {
    return "Você não tem acesso a este pagamento.";
  }

  for (const [key, message] of Object.entries(OFF_GATEWAY_ERROR_MESSAGES)) {
    if (trimmed.toUpperCase().includes(key)) return message;
  }

  if (TECHNICAL_LEAK.test(trimmed)) {
    return "Não foi possível registrar o pagamento fora do gateway. Tente novamente ou abra o pagamento no financeiro.";
  }

  return trimmed;
}
