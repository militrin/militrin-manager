import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { AdminPageHeader, AdminSection, AdminStatusBadge } from "@/components/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/admin/permissions";
import { formatDateTimeBR } from "@/lib/utils/date";
import { orderDisplayReference } from "@/lib/display-reference";
import { orderChargeBreakdown } from "@/lib/orders/charge-breakdown";
import { formatImportedHistoricalAmount } from "@/lib/imports/legacy-price";
import { formatImportedPaymentMethod } from "@/lib/imports/payment-method";
import { gatewayEnvironmentLabel, resolveGatewayEnvironment } from "@/lib/payments/gateway-environment";
import {
  canRegisterOffGatewayPayment,
  formatSettlementMethodLabel,
  resolveSettlementNature,
  settlementDisplayAmount,
  settlementNatureLabel,
} from "@/lib/finance/settlement-nature";
import {
  adminRefundVisualLabel,
  adminRefundVisualStatus,
  evaluateAdminRefundEligibility,
} from "@/lib/payments/admin-refund-eligibility";
import { classifyAdminRefundTicket, defaultCancelTicketsChecked } from "@/lib/payments/admin-refund-tickets";
import { tryGetPaymentGatewayProviderForAccountKey } from "@/lib/payments/get-gateway-provider";
import { AdminRefundPaymentModal } from "../admin-refund-modal";
import { OffGatewayPaymentModal } from "../off-gateway-modal";

type Row = Record<string, unknown>;
const one = (value: unknown): Row | null => (Array.isArray(value) ? (value[0] as Row | undefined) ?? null : (value as Row | null));

export default async function PaymentDetailPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  const supabase = await createServerSupabaseClient();
  const canRefund = await hasPermission("finance.refund");
  const canConfirmPayment = await hasPermission("finance.confirm_payment");

  const { data: payment, error } = await supabase
    .from("payments")
    .select("id,organization_id,order_id,event_id,provider,payment_status,payment_method,price_origin,gateway_payment_id,gateway_account_key,gateway_environment,final_amount,amount,discount_amount,payment_fee_customer_amount,refund_status,refunded_at,paid_at,created_at,settlement_nature,off_gateway_method,off_gateway_amount,off_gateway_received_at,off_gateway_recorded_at,off_gateway_recorded_by,off_gateway_reason,off_gateway_reference,off_gateway_destination_note,orders!payments_order_id_fkey(order_number,display_number,status,user_id,final_amount,buyer_type),participants(full_name,cpf),events(name)")
    .eq("id", paymentId)
    .maybeSingle();
  if (error) throw error;
  if (!payment?.id) notFound();

  const order = one(payment.orders);
  const participant = one(payment.participants);
  const event = one(payment.events);
  const environment = gatewayEnvironmentLabel(resolveGatewayEnvironment(payment));
  const visual = adminRefundVisualStatus(payment);
  const accountConfigured = Boolean(tryGetPaymentGatewayProviderForAccountKey(String(payment.gateway_account_key ?? "")));
  const eligibility = evaluateAdminRefundEligibility(payment, { accountKeyConfigured: accountConfigured });

  const [{ data: tickets }, { data: attempts }] = await Promise.all([
    payment.order_id
      ? supabase
        .from("tickets")
        .select("id,token,status,used_at,order_item_id,participants(full_name),order_items(holder_full_name,item_position),participant_kit_items(status)")
        .eq("order_id", payment.order_id)
      : Promise.resolve({ data: [] as Row[] }),
    supabase
      .from("payment_refund_attempts")
      .select("id,status,reason_code,reason_text,amount,environment,account_key,gateway_payment_id,cancel_tickets,failure_text,requested_at,completed_at,ticket_results")
      .eq("payment_id", paymentId)
      .order("requested_at", { ascending: false }),
  ]);

  const ticketViews = (tickets ?? []).map((ticket) => {
    const holder = one(ticket.order_items)?.holder_full_name ?? one(ticket.participants)?.full_name;
    const kitRows = Array.isArray(ticket.participant_kit_items) ? ticket.participant_kit_items : ticket.participant_kit_items ? [ticket.participant_kit_items] : [];
    return classifyAdminRefundTicket({
      id: String(ticket.id),
      token: ticket.token ? String(ticket.token) : null,
      status: ticket.status ? String(ticket.status) : null,
      usedAt: ticket.used_at ? String(ticket.used_at) : null,
      holderName: holder ? String(holder) : null,
      kitStatuses: kitRows.map((row) => String((row as Row).status ?? "")),
    });
  });

  const amountLabel = formatImportedHistoricalAmount(Number(payment.final_amount ?? payment.amount ?? 0), payment.price_origin);
  const orderLabel = order ? orderDisplayReference(order.display_number, order.order_number) : "—";
  const buyerName = participant?.full_name ? String(participant.full_name) : "—";
  const settlement = resolveSettlementNature(payment);
  const settlementAmount = settlementDisplayAmount(payment);
  const settlementAmountLabel = formatImportedHistoricalAmount(settlementAmount, payment.price_origin);
  const offGatewayEligibility = canRegisterOffGatewayPayment(payment);
  const recordedById = payment.off_gateway_recorded_by ? String(payment.off_gateway_recorded_by) : "";
  const { data: recordedByProfile } = recordedById
    ? await supabase.from("customer_profiles").select("full_name").eq("user_id", recordedById).maybeSingle()
    : { data: null };
  const recordedByName = recordedByProfile?.full_name ? String(recordedByProfile.full_name) : recordedById || "—";
  const charge = orderChargeBreakdown({
    itemsAmount: order?.final_amount ?? payment.amount,
    customerFee: payment.payment_fee_customer_amount,
    chargedAmount: payment.final_amount,
  });

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-6">
          <AdminPageHeader
            title="Pagamento"
            subtitle={`${event?.name ?? "Evento"} · ${orderLabel} · ${buyerName}`}
            actions={(
              <div className="flex flex-wrap gap-2">
                {payment.order_id ? (
                  <Link href={`/inscricoes/pedido/${payment.order_id}`} className="inline-flex items-center rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500">
                    Abrir pedido
                  </Link>
                ) : null}
                <Link href="/financeiro?tab=sales" className="inline-flex items-center rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500">
                  Voltar ao financeiro
                </Link>
              </div>
            )}
          />

          <AdminSection title="Situação" actions={<AdminStatusBadge status={visual} />}>
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Pedido" value={orderLabel} />
              <Field label="Comprador" value={buyerName} />
              <Field label="Natureza" value={settlementNatureLabel(settlement)} />
              <Field label="Método" value={formatSettlementMethodLabel(payment)} />
              <Field label="Valor do pedido" value={formatImportedHistoricalAmount(charge.itemsAmount, payment.price_origin)} />
              {charge.hasCustomerFee ? (
                <Field label="Taxa de pagamento" value={formatImportedHistoricalAmount(charge.customerFee, payment.price_origin)} />
              ) : null}
              <Field label={settlement === "off_gateway" ? "Valor recebido" : "Total cobrado"} value={settlement === "off_gateway" ? settlementAmountLabel : amountLabel} />
              <Field label="Ambiente" value={settlement === "off_gateway" ? "Nenhum" : environment ?? "—"} />
              <Field label="Status" value={adminRefundVisualLabel(visual)} />
              <Field label="Provider" value={settlement === "off_gateway" ? "Sem cobrança Asaas" : String(payment.provider ?? "—")} />
              <Field label="Conta" value={String(payment.gateway_account_key ?? "—")} />
              <Field label="Gateway id" value={settlement === "off_gateway" ? "Nenhum" : String(payment.gateway_payment_id ?? "—")} />
              <Field label="Pago em" value={payment.paid_at ? formatDateTimeBR(String(payment.paid_at)) ?? "—" : "—"} />
              <Field label="Estornado em" value={payment.refunded_at ? formatDateTimeBR(String(payment.refunded_at)) ?? "—" : "—"} />
              <Field label="Criado em" value={formatDateTimeBR(String(payment.created_at)) ?? "—"} />
              <Field label="Método original da emissão" value={formatImportedPaymentMethod(payment.payment_method)} />
            </div>
            {settlement === "off_gateway" ? (
              <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
                <p className="text-xs uppercase tracking-wide text-emerald-300">Pago</p>
                <p className="mt-1 text-lg font-semibold text-emerald-100">{formatSettlementMethodLabel(payment)}</p>
                <p className="mt-1 font-semibold text-white">{settlementAmountLabel}</p>
                <p className="mt-2 text-emerald-100">Recebido em: {payment.off_gateway_received_at ? formatDateTimeBR(String(payment.off_gateway_received_at)) ?? "—" : "—"}</p>
                <p className="text-emerald-100">Registrado por: {recordedByName}</p>
                <p className="text-emerald-100">Sem cobrança Asaas</p>
                {payment.off_gateway_reason ? <p className="mt-2 text-slate-200">Motivo: {String(payment.off_gateway_reason)}</p> : null}
                {payment.off_gateway_reference ? <p className="text-slate-300">Referência: {String(payment.off_gateway_reference)}</p> : null}
                {payment.off_gateway_destination_note ? <p className="text-slate-300">Destino: {String(payment.off_gateway_destination_note)}</p> : null}
              </div>
            ) : null}
            {String(order?.buyer_type ?? "") === "administrative" || String(payment.payment_method ?? "") === "courtesy" ? (
              <p className="mt-3 text-xs text-slate-400">
                Emissão original administrativa preservada: {formatImportedPaymentMethod(payment.payment_method)}
                {payment.amount != null ? ` · catálogo ${formatImportedHistoricalAmount(Number(payment.amount), payment.price_origin)}` : ""}
                {payment.discount_amount != null ? ` · desconto ${formatImportedHistoricalAmount(Number(payment.discount_amount), payment.price_origin)}` : ""}
                {` · final ${amountLabel}`}.
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {canConfirmPayment && offGatewayEligibility.allowed ? (
                <OffGatewayPaymentModal
                  paymentId={String(payment.id)}
                  orderLabel={orderLabel}
                  buyerName={buyerName}
                  replace={offGatewayEligibility.replace}
                />
              ) : canConfirmPayment && offGatewayEligibility.reason ? (
                <p className="text-sm text-slate-400">{offGatewayEligibility.reason}</p>
              ) : null}
              {canRefund && eligibility.eligible && eligibility.needsConfirmPhrase ? (
                <AdminRefundPaymentModal
                  paymentId={String(payment.id)}
                  orderLabel={orderLabel}
                  amountLabel={amountLabel}
                  methodLabel={formatImportedPaymentMethod(payment.payment_method)}
                  environmentLabel={environment ?? "—"}
                  statusLabel={adminRefundVisualLabel(visual)}
                  gatewayPaymentId={String(payment.gateway_payment_id ?? "—")}
                  confirmPhrase={eligibility.needsConfirmPhrase}
                  defaultCancelTickets={defaultCancelTicketsChecked(ticketViews)}
                  tickets={ticketViews}
                  triggerLabel="ESTORNAR PAGAMENTO"
                />
              ) : canRefund && eligibility.canReconcile && eligibility.needsConfirmPhrase === null ? (
                <AdminRefundPaymentModal
                  paymentId={String(payment.id)}
                  orderLabel={orderLabel}
                  amountLabel={amountLabel}
                  methodLabel={formatImportedPaymentMethod(payment.payment_method)}
                  environmentLabel={environment ?? "—"}
                  statusLabel={adminRefundVisualLabel(visual)}
                  gatewayPaymentId={String(payment.gateway_payment_id ?? "—")}
                  confirmPhrase={`Confirmo o estorno de ${amountLabel}`}
                  defaultCancelTickets={false}
                  tickets={ticketViews}
                  mode="reconcile"
                  triggerLabel="Conciliar estorno"
                />
              ) : null}
              {!eligibility.eligible ? (
                <p className="text-sm text-amber-100">{eligibility.reason}</p>
              ) : !canRefund ? (
                <p className="text-sm text-slate-400">Estorno visível apenas para quem tem permissão financeira de refund.</p>
              ) : null}
            </div>
          </AdminSection>

          <AdminSection title="Ingressos associados">
            {!ticketViews.length ? (
              <p className="text-sm text-slate-400">Nenhum ingresso vinculado a este pagamento.</p>
            ) : (
              <div className="space-y-2">
                {ticketViews.map((ticket) => (
                  <div key={ticket.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm">
                    <div>
                      <p className="font-semibold text-slate-100">{ticket.code} · {ticket.holderName}</p>
                      <p className="text-xs text-slate-400">
                        {ticket.status}
                        {ticket.usedAt ? " · check-in" : ""}
                        {ticket.kitStatus === "delivered" ? " · kit entregue" : ticket.kitStatus === "pending" ? " · kit não entregue" : ""}
                      </p>
                    </div>
                    <Link href={`/ingressos/${ticket.id}`} className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200">Ver ingresso</Link>
                  </div>
                ))}
              </div>
            )}
          </AdminSection>

          <AdminSection title="Histórico de estorno">
            {!attempts?.length ? (
              <p className="text-sm text-slate-400">Nenhuma tentativa de estorno registrada.</p>
            ) : (
              <div className="space-y-2 text-sm">
                {attempts.map((attempt) => (
                  <div key={attempt.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                    <p className="font-semibold text-slate-100">{adminRefundVisualLabel(String(attempt.status))}</p>
                    <p className="text-xs text-slate-400">
                      {attempt.reason_code} · {formatImportedHistoricalAmount(Number(attempt.amount ?? 0))}
                      {attempt.cancel_tickets ? " · cancelar ingressos" : ""}
                    </p>
                    <p className="text-xs text-slate-500">
                      solicitado {attempt.requested_at ? formatDateTimeBR(String(attempt.requested_at)) : "—"}
                      {attempt.completed_at ? ` · concluído ${formatDateTimeBR(String(attempt.completed_at))}` : ""}
                    </p>
                    {attempt.failure_text ? <p className="mt-1 text-xs text-rose-200">{String(attempt.failure_text)}</p> : null}
                  </div>
                ))}
              </div>
            )}
          </AdminSection>
        </div>
      </div>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="font-semibold text-slate-100">{value}</p>
    </div>
  );
}
