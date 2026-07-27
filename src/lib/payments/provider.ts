export type PaymentMethod = "pix" | "credit_card" | "cash" | "courtesy";

export type PaymentStatus = "pending" | "paid" | "expired" | "cancelled" | "refunded";

export type PixPayload = {
  pixCode: string;
  pixQrCode: string;
  gatewayPaymentId: string;
  expiresAt: string;
};

export interface PaymentProvider {
  createPix(input: { participantId: string; amount: number; expiresInMinutes: number }): Promise<PixPayload>;
  confirmPayment(input: { participantId: string; method: PaymentMethod }): Promise<{ confirmedAt: string }>;
  cancelPayment(input: { participantId: string; reason?: string }): Promise<{ cancelledAt: string }>;
  refund(input: { participantId: string; reason?: string }): Promise<{ refundedAt: string }>;
}
