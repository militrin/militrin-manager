export type TicketEmailPayload = {
  to: string;
  participantName: string;
  eventName: string;
  eventDate: string | null;
  eventLocation: string | null;
  categoryName: string | null;
  kitItems: Array<{ name: string; quantity: number }>;
  orderNumber: string;
  ticketToken: string;
  accountUrl: string;
};

export interface EmailProvider {
  sendAccountConfirmation(input: { to: string; confirmationUrl?: string }): Promise<void>;
  sendPaymentPending(input: { to: string; participantName: string; amount: number; paymentMethod: string; expiresAt: string | null; pixCode: string | null }): Promise<void>;
  sendTicketConfirmation(input: TicketEmailPayload): Promise<void>;
  sendPasswordReset(input: { to: string; resetUrl?: string }): Promise<void>;
}
