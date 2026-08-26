import { NextResponse } from "next/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { getPaymentGatewayProvider } from "@/lib/payments/get-gateway-provider";

/**
 * Webhook Asaas -- Fase 1 (fundacao). NAO emite ticket a partir de nenhum
 * campo arbitrario do payload: so aceita o evento depois de validar o
 * token (`verifyWebhook`), gravar/deduplicar em `payment_gateway_events`
 * (idempotencia -- o mesmo evento pode chegar 2x, 10x, ou em requests
 * concorrentes, comportamento "at-least-once" documentado pela Asaas) e so
 * entao localizar o pagamento interno correspondente via
 * `apply_gateway_payment_status`, que e quem decide (com o payment travado
 * por `FOR UPDATE`) se algo muda em order/order_items/tickets.
 *
 * Esta rota nao esta ligada ao checkout publico: nenhum botao gera cobranca
 * Asaas ainda (Fase 2). Ela existe para que a infraestrutura de recebimento
 * possa ser testada em sandbox de forma isolada.
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
    p_payload: event.rawPayload as object,
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
    // Duplicata (mesmo evento reenviado) ou concorrencia (outra requisicao
    // ja esta processando este mesmo evento agora): nunca reprocessar aqui.
    return NextResponse.json({ ok: true, deduped: true });
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
      await supabase.rpc("mark_payment_gateway_event_processed", {
        p_event_id: eventId,
        p_status: isUnknownPayment ? "ignored" : "failed",
        p_error: applyError.message,
      });

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
