import { NextResponse } from "next/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { getPaymentGatewayProvider } from "@/lib/payments/get-gateway-provider";
import { sanitizePaymentGatewayEventPayload } from "@/lib/payments/sanitize-gateway-event-payload";

/**
 * Webhook Asaas. NAO emite ticket a partir de nenhum campo arbitrario do
 * payload: valida o token (`verifyWebhook`), grava/deduplica em
 * `payment_gateway_events` e so entao aplica via `apply_gateway_payment_status`.
 *
 * URL publica: POST /api/webhooks/asaas
 * Autenticacao: header `asaas-access-token` (token atual ou o anterior,
 * `ASAAS_WEBHOOK_TOKEN_PREVIOUS`, durante troca de conta).
 */
export async function POST(request: Request) {
  let provider;
  try {
    provider = getPaymentGatewayProvider("asaas");
  } catch (error) {
    console.error("[webhook:asaas] provider_not_configured", error);
    return NextResponse.json({ error: "Asaas provider nao configurado." }, { status: 503 });
  }

  const rawBody = await request.text();

  if (!provider.verifyWebhook({ headers: request.headers, rawBody })) {
    console.warn("[webhook:asaas] invalid_token");
    return NextResponse.json({ error: "Token de webhook invalido." }, { status: 401 });
  }

  let event;
  try {
    event = provider.parseWebhook({ rawBody });
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
    // processing recente (outro worker vivo) ou abandonado ainda dentro do
    // lease: 503 faz o Asaas retentar. 200 aqui faria o gateway desistir
    // antes do reclaim de 3 minutos.
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
    });

    if (applyError) {
      const isUnknownPayment = applyError.message === "PAYMENT_NOT_FOUND";

      // Pagamento confirmado pelo gateway sem correlação local: cobrança órfã paga.
      // NÃO tratamos como sucesso silencioso — classificamos como divergência
      // financeira para que o administrador possa investigar.
      // NÃO emitimos ingresso automaticamente.
      const isFinancialDivergence =
        isUnknownPayment &&
        (event.status === "paid" || event.status === "processing");

      await supabase.rpc("mark_payment_gateway_event_processed", {
        p_event_id: eventId,
        p_status: isFinancialDivergence
          ? "financial_divergence"
          : isUnknownPayment
            ? "ignored"
            : "failed",
        p_error: isFinancialDivergence
          ? `ORPHAN_CHARGE: pagamento ${event.providerPaymentId ?? "desconhecido"} confirmado pelo gateway mas sem payment local correspondente. Requer investigação.`
          : applyError.message,
      });

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
        // Retornamos 200 para que o Asaas não retente infinitamente uma
        // divergência que já está registrada e visível ao administrador.
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
