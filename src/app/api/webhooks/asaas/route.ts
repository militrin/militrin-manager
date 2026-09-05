import { NextResponse } from "next/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { resolveAsaasWebhookAccountKey } from "@/lib/payments/asaas-account-registry";
import { parseAsaasWebhookPayload } from "@/lib/payments/asaas-provider";
import { sanitizePaymentGatewayEventPayload } from "@/lib/payments/sanitize-gateway-event-payload";

/**
 * Webhook Asaas multi-conta. Uma URL: POST /api/webhooks/asaas
 *
 * 1) O token (`asaas-access-token`) identifica a conta (PIX vs CARD).
 * 2) Dedup em `payment_gateway_events` inclui gateway_account_key.
 * 3) `apply_gateway_payment_status` so atualiza payment com o mesmo
 *    provider + gateway_payment_id + gateway_account_key.
 *
 * Token da conta PIX nao atualiza cobranca da conta CARD.
 */
export async function POST(request: Request) {
  let accountKey: string | null;
  try {
    accountKey = resolveAsaasWebhookAccountKey(request.headers);
  } catch (error) {
    console.error("[webhook:asaas] token_ambiguous", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Token de webhook invalido." }, { status: 401 });
  }

  if (!accountKey) {
    console.warn("[webhook:asaas] invalid_token");
    return NextResponse.json({ error: "Token de webhook invalido." }, { status: 401 });
  }

  const rawBody = await request.text();

  let event;
  try {
    event = parseAsaasWebhookPayload(rawBody);
  } catch (error) {
    console.error("[webhook:asaas] invalid_payload", error);
    return NextResponse.json({ error: "Payload invalido." }, { status: 400 });
  }

  if (!event.externalEventId) {
    return NextResponse.json({ error: "Evento sem id." }, { status: 400 });
  }

  const supabase = createServiceRoleSupabaseClient();

  const { data: recordData, error: recordError } = await supabase.rpc("record_payment_gateway_event", {
    p_provider: "asaas",
    p_external_event_id: event.externalEventId,
    p_event_type: event.eventType,
    p_provider_payment_id: event.providerPaymentId,
    p_payload: sanitizePaymentGatewayEventPayload(event.rawPayload),
    p_gateway_account_key: accountKey,
  });

  if (recordError) {
    console.error("[webhook:asaas] record_event_failed", recordError);
    return NextResponse.json({ error: "Falha ao registrar evento." }, { status: 500 });
  }

  const recorded = (Array.isArray(recordData) ? recordData[0] : recordData) as { id: string; is_new: boolean } | null;
  const eventId = recorded?.id;
  if (!eventId) {
    console.error("[webhook:asaas] record_event_missing_id", recordData);
    return NextResponse.json({ error: "Falha ao registrar evento." }, { status: 500 });
  }

  const { data: claimed, error: claimError } = await supabase.rpc("claim_payment_gateway_event_for_processing", {
    p_event_id: eventId,
  });

  if (claimError) {
    console.error("[webhook:asaas] claim_failed", claimError);
    return NextResponse.json({ error: "Falha ao reivindicar evento." }, { status: 500 });
  }

  if (!claimed) {
    const { data: existing } = await supabase
      .from("payment_gateway_events")
      .select("processing_status")
      .eq("id", eventId)
      .maybeSingle();
    const status = String(existing?.processing_status ?? "");
    if (status === "processed" || status === "ignored") {
      return NextResponse.json({ ok: true, deduped: true });
    }
    return NextResponse.json({ error: "Evento em processamento." }, { status: 503 });
  }

  if (!event.providerPaymentId || !event.status) {
    await supabase.rpc("mark_payment_gateway_event_processed", {
      p_event_id: eventId,
      p_status: "ignored",
      p_error: "provider_payment_id ou status ausente/nao mapeavel no payload.",
    });
    return NextResponse.json({ ok: true, ignored: true });
  }

  try {
    const { data: applyData, error: applyError } = await supabase.rpc("apply_gateway_payment_status", {
      p_provider: "asaas",
      p_provider_payment_id: event.providerPaymentId,
      p_provider_status: event.providerStatus,
      p_internal_status: event.status,
      p_expected_gateway_account_key: accountKey,
      p_event_type: event.eventType,
    });

    if (applyError) {
      const isUnknownPayment = applyError.message === "PAYMENT_NOT_FOUND";
      const isAccountMismatch = applyError.message === "GATEWAY_ACCOUNT_MISMATCH";

      const isFinancialDivergence =
        isUnknownPayment &&
        (event.status === "paid" || event.status === "processing");

      await supabase.rpc("mark_payment_gateway_event_processed", {
        p_event_id: eventId,
        p_status: isFinancialDivergence
          ? "financial_divergence"
          : isUnknownPayment || isAccountMismatch
            ? "ignored"
            : "failed",
        p_error: isAccountMismatch
          ? `GATEWAY_ACCOUNT_MISMATCH: webhook da conta ${accountKey} nao pode atualizar cobranca de outra conta.`
          : isFinancialDivergence
            ? `ORPHAN_CHARGE: pagamento ${event.providerPaymentId ?? "desconhecido"} confirmado pelo gateway mas sem payment local correspondente. Requer investigação.`
            : applyError.message,
      });

      if (isAccountMismatch) {
        console.error("[webhook:asaas] gateway_account_mismatch", {
          provider_payment_id: event.providerPaymentId,
          webhook_account_key: accountKey,
          event_id: eventId,
        });
        return NextResponse.json({ ok: true, ignored: true, account_mismatch: true });
      }

      if (isFinancialDivergence) {
        console.error(
          "[webhook:asaas] financial_divergence",
          {
            provider_payment_id: event.providerPaymentId,
            event_type: event.eventType,
            internal_status: event.status,
            event_id: eventId,
          },
        );
        return NextResponse.json({ ok: true, financial_divergence: true });
      }

      if (isUnknownPayment) {
        console.warn("[webhook:asaas] payment_not_found", event.providerPaymentId);
        return NextResponse.json({ ok: true, ignored: true });
      }

      console.error("[webhook:asaas] apply_status_failed", applyError);
      return NextResponse.json({ error: "Falha ao aplicar status do pagamento." }, { status: 500 });
    }

    const applied = (Array.isArray(applyData) ? applyData[0] : applyData) as { organization_id: string | null } | null;

    await supabase.rpc("mark_payment_gateway_event_processed", {
      p_event_id: eventId,
      p_status: "processed",
      p_organization_id: applied?.organization_id ?? null,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[webhook:asaas] unexpected_error", error);
    await supabase.rpc("mark_payment_gateway_event_processed", {
      p_event_id: eventId,
      p_status: "failed",
      p_error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Erro interno." }, { status: 500 });
  }
}
