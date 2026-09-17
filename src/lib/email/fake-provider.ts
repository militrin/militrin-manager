import type { EmailProvider, TicketEmailPayload } from "@/lib/email/provider";
import { OKTOBERFEST_ACCESS_NOTICE } from "@/lib/public/oktoberfest-access-notice";

function logMail(kind: string, payload: unknown) {
  console.log(`[email:${kind}]`, JSON.stringify(payload, null, 2));
}

export class ConsoleEmailProvider implements EmailProvider {
  async sendAccountConfirmation(input: { to: string; confirmationUrl?: string }): Promise<void> {
    // Metodo legado da interface EmailProvider. NAO e o mailer de confirmacao
    // GoTrue/Supabase Auth. Nenhuma superficie de signup deve chama-lo.
    // Confirmacao de Auth com token real e exclusiva de supabase.auth.resend/signUp.
    console.warn("[email:account-confirmation-ignored]", {
      to: input.to,
      reason: "GoTrue/Supabase Auth envia o token de confirmacao. MILITRIN_EMAIL_PROVIDER nao duplica esse e-mail.",
    });
  }

  async sendPaymentPending(input: { to: string; participantName: string; amount: number; paymentMethod: string; expiresAt: string | null; pixCode: string | null }): Promise<void> {
    logMail("payment-pending", input);
  }

  async sendTicketConfirmation(input: TicketEmailPayload): Promise<void> {
    // Templates HTML reais ficam no provedor de e-mail; este log documenta a copy obrigatória.
    logMail("ticket-confirmation", {
      ...input,
      qrUsage: "Use seu QR Code para retirar o kit Militrin.",
      importantNotice: `Importante: ${OKTOBERFEST_ACCESS_NOTICE.full}`,
    });
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
