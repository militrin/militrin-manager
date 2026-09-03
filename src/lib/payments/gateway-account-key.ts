/**
 * Rotulo logico da conta/configuracao Asaas ativa (`ASAAS_ACCOUNT_KEY`).
 * Identificador curto (ex. militrin-temp / militrin-oficial) -- nunca a API key.
 */

export function getPaymentGatewayAccountKey(): string | null {
  const key = String(process.env.ASAAS_ACCOUNT_KEY ?? "").trim();
  return key || null;
}

/**
 * So opera na API da conta ativa quando a cobranca persistida tem o mesmo
 * rotulo. Sem rotulo (legado) ou rotulo diferente: origem desconhecida --
 * nao chamar a conta nova com id da conta antiga.
 */
export function canUseCurrentGatewayForCharge(storedAccountKey: string | null | undefined): boolean {
  const stored = String(storedAccountKey ?? "").trim();
  if (!stored) return false;
  const current = getPaymentGatewayAccountKey();
  if (!current) return false;
  return stored === current;
}
