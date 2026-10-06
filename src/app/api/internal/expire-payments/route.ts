import { NextResponse } from "next/server";
import { expireAndCancelStaleCheckoutPayments } from "@/lib/payments/expire-and-cancel-stale";

function authorized(request: Request) {
  const secret = String(process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  if (header === `Bearer ${secret}`) return true;
  return request.headers.get("x-cron-secret") === secret;
}

/**
 * Worker de expiracao PIX/cartao. Quem chama em producao: Vercel Cron
 * GET /api/internal/expire-payments a cada 1 min (`vercel.json`), com
 * Authorization: Bearer $CRON_SECRET. Sem CRON_SECRET o endpoint recusa.
 * pg_cron so carimba pending_cancel; este worker faz o DELETE Asaas
 * (PIX: cobranca unica; cartao: todas as charges/parcelas).
 */
export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
  }

  try {
    const result = await expireAndCancelStaleCheckoutPayments();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[expire-payments] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao expirar pagamentos." },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return POST(request);
}
