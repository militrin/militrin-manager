import { PaymentProvider, type PaymentMethod } from "@/lib/payments/provider";

function randomToken(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 11)}_${Date.now()}`;
}

function buildFakePixCode(participantId: string, amount: number) {
  const amountPart = Number(amount).toFixed(2).replace(".", "");
  return `00020126580014BR.GOV.BCB.PIX0136militrin-${participantId}520400005303986540${amountPart}5802BR5920MILITRIN MANAGER6009SAO PAULO62070503***6304FAKE`;
}

function buildFakeQrDataUrl(content: string) {
  const safe = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='280' height='280'><rect width='100%' height='100%' fill='#0f172a'/><rect x='20' y='20' width='240' height='240' rx='16' fill='#111827' stroke='#10b981'/><text x='24' y='52' fill='#10b981' font-size='14' font-family='monospace'>PIX FICTICIO</text><text x='24' y='86' fill='#e5e7eb' font-size='10' font-family='monospace'>${safe.slice(0, 32)}</text><text x='24' y='104' fill='#e5e7eb' font-size='10' font-family='monospace'>${safe.slice(32, 64)}</text><text x='24' y='122' fill='#e5e7eb' font-size='10' font-family='monospace'>${safe.slice(64, 96)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export class FakePaymentProvider implements PaymentProvider {
  async createPix(input: { participantId: string; amount: number; expiresInMinutes: number }) {
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60 * 1000).toISOString();
    const pixCode = buildFakePixCode(input.participantId, input.amount);
    return {
      pixCode,
      pixQrCode: buildFakeQrDataUrl(pixCode),
      gatewayPaymentId: randomToken("pix"),
      expiresAt,
    };
  }

  async confirmPayment(input: { participantId: string; method: PaymentMethod }) {
    void input;
    return { confirmedAt: new Date().toISOString() };
  }

  async cancelPayment(input: { participantId: string; reason?: string }) {
    void input;
    return { cancelledAt: new Date().toISOString() };
  }

  async refund(input: { participantId: string; reason?: string }) {
    void input;
    return { refundedAt: new Date().toISOString() };
  }
}
