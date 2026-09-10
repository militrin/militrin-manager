/**
 * Detecta cobranca/PIX sintetico da Loja (FakePaymentProvider legado e
 * FakeGatewayProvider). Nunca exibir nem confirmar como pagamento real.
 */
export function isSyntheticGatewayPayload(input: {
  pixCode?: string | null;
  pixQrCode?: string | null;
  gatewayPaymentId?: string | null;
  provider?: string | null;
}): boolean {
  const provider = String(input.provider ?? "").trim().toLowerCase();
  if (provider === "fake") return true;

  const gatewayId = String(input.gatewayPaymentId ?? "").trim();
  if (/^fake_/i.test(gatewayId)) return true;
  if (/^pix_[a-z0-9]+_\d+$/i.test(gatewayId)) return true;

  const blob = `${input.pixCode ?? ""}\n${input.pixQrCode ?? ""}`;
  return /6304FAKE|FAKEPIX|PIX FICTICIO|PIX FICTÍCIO/i.test(blob);
}
