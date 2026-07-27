import type { EmailProvider, TicketEmailPayload } from "@/lib/email/provider";

function logMail(kind: string, payload: unknown) {
  console.log(`[email:${kind}]`, JSON.stringify(payload, null, 2));
}

export class ConsoleEmailProvider implements EmailProvider {
  async sendAccountConfirmation(input: { to: string; confirmationUrl?: string }): Promise<void> {
    logMail("account-confirmation", input);
  }

  async sendPaymentPending(input: { to: string; participantName: string; amount: number; paymentMethod: string; expiresAt: string | null; pixCode: string | null }): Promise<void> {
    logMail("payment-pending", input);
  }

  async sendTicketConfirmation(input: TicketEmailPayload): Promise<void> {
    logMail("ticket-confirmation", input);
  }

  async sendPasswordReset(input: { to: string; resetUrl?: string }): Promise<void> {
    logMail("password-reset", input);
  }
}

let warnedNoProvider = false;

export function getEmailProvider() {
  if (!process.env.MILITRIN_EMAIL_PROVIDER && !warnedNoProvider) {
    warnedNoProvider = true;
    console.warn("MILITRIN_EMAIL_PROVIDER não definido. Usando ConsoleEmailProvider (modo desenvolvimento).");
  }
  return new ConsoleEmailProvider();
}
