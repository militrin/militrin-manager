import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { AdminEmptyState, AdminPageHeader, AdminSection, AdminStatCard, AdminStatusBadge } from "@/components/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAdminAccessContext } from "@/lib/admin/access";
import { hasPermission } from "@/lib/admin/permissions";
import { formatDateTimeBR } from "@/lib/utils/date";
import { orderDisplayReference } from "@/lib/display-reference";
import { resolveCommercialStatus, commercialStatusFriendlyReason, resolveBuyerPresentation, COMMERCIAL_STATUS_LABELS } from "@/lib/dashboard/commercial-status";

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const one = (value: unknown): Row | null => (Array.isArray(value) ? (value[0] as Row | undefined) ?? null : (value as Row | null));

function maskCpf(cpf: string | null | undefined) {
  const digits = String(cpf ?? "").replace(/\D/g, "");
  if (digits.length !== 11) return "Não informado";
  return `***.***.***-${digits.slice(-2)}`;
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  pix: "PIX", credit_card: "Cartão de crédito", cash: "Dinheiro", courtesy: "Cortesia",
};

// Pedido/inscrição comercial que ainda NÃO emitiu ingresso (pendente, expirado
// ou em qualquer estado anterior à emissão). Existe pra dar destino real ao
// clique em "Ver pedido" no Dashboard -- antes disso apontava "Ver ingresso"
// pra um ticket que nunca existiu. Ingresso emitido continua abrindo em
// /ingressos/[ticketId] (rota canônica, não duplicada aqui).
export default async function OrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const supabase = await createServerSupabaseClient();
  const { canViewFinancial } = await getAdminAccessContext();

  const { data: order, error } = await supabase
    .from("orders")
    .select("id,order_number,display_number,status,buyer_type,user_id,base_amount,discount_amount,final_amount,created_at,confirmed_at,cancelled_at,event_id,events(name)")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!order?.id) notFound();
  const eventRelation = Array.isArray(order.events) ? order.events[0] : order.events;

  const [{ data: items }, { data: payments }, { data: tickets }] = await Promise.all([
    supabase
      .from("order_items")
      .select("id,item_position,status,item_kind,holder_full_name,holder_email,holder_phone,participant_id,quantity,unit_price,discount_amount,final_amount,shirt_type,shirt_size,reservation_expires_at,registration_batches(name),ticket_categories(name),participants(full_name,cpf,phone,email),store_items(name),store_item_variants(name,value)")
      .eq("order_id", orderId)
      .order("item_position", { ascending: true }),
    supabase
      .from("payments")
      .select("id,payment_status,payment_method,final_amount,created_at,paid_at")
      .eq("order_id", orderId)
      .order("created_at", { ascending: false }),
    supabase.from("tickets").select("id,order_item_id,status,cancellation_replacement_required").eq("order_id", orderId),
  ]);

  // Mesma regra ja auditada e publicada em owner_cancel_ticket (acesso a
  // organizacao + Owner OU orders.cancel) -- decide so se o CTA de
  // regularizacao aparece aqui; a acao em si (reclassificar) so acontece na
  // ficha do ingresso, nunca duplicada nesta listagem.
  const canRegularizeCancellation = await hasPermission("orders.cancel");

  // Auditoria do caso real #001078 (Integridade Operacional, P0): esta pagina
  // tratava "existe uma linha em tickets" como "ingresso valido" e mostrava
  // "Ver ingresso" -- mesmo quando o unico ticket daquele item estava
  // CANCELADO (ex.: cancelamento administrativo sem reemissao). O item
  // continuava com status='confirmed' e a UI escondia o problema real.
  // confirm_order_item_and_issue_ticket bloqueia deliberadamente reativar um
  // ticket cancelado (20260897000000_harden_ticket_reactivation_guard.sql),
  // entao hoje NAO existe uma acao segura de "reemitir" pra este estado --
  // a pagina precisa expor isso claramente, nunca esconder atras de um botao
  // que parece funcionar mas nao muda nada.
  const ticketByItem = new Map((tickets ?? []).map((ticket) => [String(ticket.order_item_id ?? ""), { id: String(ticket.id), status: String(ticket.status ?? ""), replacementRequired: ticket.cancellation_replacement_required as boolean | null }]));
  const latestPayment = (payments ?? [])[0] ?? null;

  let buyerName: string | null = null;
  if (order.user_id) {
    const { data: buyers } = await supabase.rpc("get_operation_buyers", { p_event_id: order.event_id });
    const buyer = ((buyers ?? []) as Array<Record<string, unknown>>).find((row) => String(row.user_id ?? "") === String(order.user_id));
    if (buyer?.full_name) buyerName = String(buyer.full_name);
  }

  // Mesmo discriminador canonico do detector PAID_ORDER_WITHOUT_TICKET
  // (order_items.item_kind) -- produto "compre junto" (item_kind='product')
  // nunca gera ticket por design e nao deve ser contado nem rotulado como
  // ingresso (auditoria da Central de Integridade, falsos positivos em
  // MIL-2026-00001086/00001089).
  const ticketItems = (items ?? []).filter((item) => (item.item_kind ?? "ticket") === "ticket") as Row[];
  const productItems = (items ?? []).filter((item) => item.item_kind === "product") as Row[];

  const firstItem = (items ?? [])[0] as Row | undefined;
  const holderName = firstItem?.holder_full_name ?? one(firstItem?.participants)?.full_name ?? null;
  const buyerPresentation = resolveBuyerPresentation({
    buyerType: order.buyer_type, buyerName, holderName, paymentMethod: latestPayment?.payment_method,
  });

  const commercialStatus = resolveCommercialStatus({
    orderStatus: order.status,
    paymentStatus: latestPayment?.payment_status,
    reservationExpiresAt: firstItem?.reservation_expires_at ?? null,
  });
  const friendlyReason = commercialStatusFriendlyReason(commercialStatus, Boolean(latestPayment));

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-6">
          <AdminPageHeader
            title={`Pedido ${orderDisplayReference(order.display_number, order.order_number)}`}
            subtitle={`${eventRelation?.name ?? "Evento"} · ${ticketItems.length} ingresso(s)${productItems.length ? ` · ${productItems.length} item(ns) adicional(is)` : ""}`}
            actions={<Link href="/inscricoes" className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500">Voltar</Link>}
          />

          <AdminSection title="Situação" actions={<AdminStatusBadge status={commercialStatus} />}>
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Field label={buyerPresentation.label} value={buyerPresentation.name} />
              <Field label="Evento" value={eventRelation?.name ?? "—"} />
              <Field label="Forma de pagamento tentada" value={latestPayment?.payment_method ? (PAYMENT_METHOD_LABELS[latestPayment.payment_method] ?? latestPayment.payment_method) : "Não informado"} />
              <Field label="Valor" value={canViewFinancial ? money(order.final_amount ?? 0) : "Restrito"} />
              <Field label="Criado em" value={formatDateTimeBR(order.created_at) ?? "—"} />
              <Field label="Prazo de pagamento" value={firstItem?.reservation_expires_at ? formatDateTimeBR(firstItem.reservation_expires_at) ?? "—" : "—"} />
              <Field label="Confirmado em" value={order.confirmed_at ? formatDateTimeBR(order.confirmed_at) ?? "—" : "—"} />
              <Field label="Referência" value={orderDisplayReference(order.display_number, order.order_number)} />
            </div>
            {friendlyReason ? (
              <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">{friendlyReason}</div>
            ) : null}
          </AdminSection>

          <AdminSection title={`Ingresso(s) do pedido (${ticketItems.length})`}>
            {!ticketItems.length ? <AdminEmptyState title="Nenhum ingresso encontrado" description="Este pedido não tem itens de ingresso registrados." /> : (
              <div className="space-y-2">
                {ticketItems.map((item) => {
                  const participant = one(item.participants);
                  const ticket = ticketByItem.get(String(item.id));
                  const category = one(item.ticket_categories);
                  const batch = one(item.registration_batches);
                  const name = item.holder_full_name ?? participant?.full_name ?? "Titular não definido";

                  // Mesma semantica do detector PAID_ORDER_WITHOUT_TICKET
                  // (nao duplicar regra, so refletir): so e um problema real
                  // quando o ITEM ja esta comercialmente confirmado e nao tem
                  // ticket ativo (cancelado nao conta como ativo). Esta
                  // secao ja so recebe item_kind='ticket' (filtrado acima).
                  // cancellation_replacement_required=false (classificado via
                  // regularizacao) e a MESMA excecao que o detector ja aplica
                  // (20260924000000) -- deixa de ser tratado como pendencia
                  // aqui tambem, nunca so no card de Integridade.
                  const isConfirmedItem = item.status === "confirmed" || item.status === "transferred";
                  const hasActiveTicket = Boolean(ticket) && ticket!.status !== "cancelled";
                  const hasCancelledOnlyTicket = Boolean(ticket) && ticket!.status === "cancelled";
                  const cancellationResolved = hasCancelledOnlyTicket && ticket!.replacementRequired === false;
                  const cancellationNeedsRegularization = hasCancelledOnlyTicket && ticket!.replacementRequired === null;
                  const missingTicket = isConfirmedItem && !hasActiveTicket && !cancellationResolved;

                  return (
                    <div key={item.id} className={`rounded-xl border p-3 text-sm ${missingTicket ? "border-rose-500/40 bg-rose-500/5" : "border-slate-800 bg-slate-900/60"}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-100">Item {item.item_position ?? "—"} · {name}</p>
                          <p className="text-xs text-slate-400">
                            {category?.name ?? "Ingresso único"} · {batch?.name ?? "Sem lote"}
                            {item.shirt_type ? ` · ${item.shirt_type} ${item.shirt_size ?? ""}` : ""}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            CPF {maskCpf(participant?.cpf)}
                            {canViewFinancial ? ` · ${money(item.final_amount ?? 0)}` : ""}
                          </p>
                          {missingTicket ? (
                            <p className="mt-2 text-xs text-rose-200">
                              {cancellationNeedsRegularization
                                ? "O ingresso emitido para este item foi cancelado administrativamente antes de o sistema registrar se haveria substituto. Requer regularização manual."
                                : hasCancelledOnlyTicket
                                  ? "O ingresso emitido para este item foi cancelado administrativamente e ainda exige um substituto — nenhum foi emitido até agora."
                                  : "O pedido foi confirmado, mas este item ainda não possui ingresso emitido. Revise o pedido e emita ou regularize o ingresso."}
                            </p>
                          ) : cancellationResolved ? (
                            <p className="mt-2 text-xs text-slate-400">Ingresso cancelado definitivamente — nenhum substituto é exigido.</p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          {hasActiveTicket ? (
                            <Link href={`/ingressos/${ticket!.id}`} className="inline-flex h-8 shrink-0 items-center rounded-lg border border-cyan-500/40 px-2.5 text-xs text-cyan-200">
                              Ver ingresso
                            </Link>
                          ) : hasCancelledOnlyTicket ? (
                            <Link href={`/ingressos/${ticket!.id}${cancellationNeedsRegularization ? "#regularizacao-cancelamento" : ""}`} className="inline-flex h-8 shrink-0 items-center rounded-lg border border-rose-500/40 px-2.5 text-xs text-rose-200">
                              Ver ingresso cancelado
                            </Link>
                          ) : missingTicket ? (
                            <span className="shrink-0 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-200">Ingresso não emitido</span>
                          ) : (
                            <span className="shrink-0 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400">Aguardando pagamento</span>
                          )}
                          {cancellationNeedsRegularization && canRegularizeCancellation ? (
                            <Link href={`/ingressos/${ticket!.id}#regularizacao-cancelamento`} className="inline-flex h-8 shrink-0 items-center rounded-lg bg-amber-500 px-2.5 text-xs font-medium text-slate-950">
                              Regularizar cancelamento
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </AdminSection>

          {productItems.length ? (
            <AdminSection title={`Itens / produtos do pedido (${productItems.length})`}>
              <div className="space-y-2">
                {productItems.map((item) => {
                  const storeItem = one(item.store_items);
                  const variant = one(item.store_item_variants);
                  const name = storeItem?.name ?? "Produto";
                  const variantText = variant ? `${variant.name}: ${variant.value}` : null;
                  const deliveryLabel =
                    item.status === "delivered" ? "Entregue" : item.status === "cancelled" || item.status === "expired" || item.status === "refunded" ? "Cancelado" : "Aguardando retirada";
                  const deliveryClass =
                    item.status === "delivered"
                      ? "border-emerald-500/40 text-emerald-200"
                      : item.status === "cancelled" || item.status === "expired" || item.status === "refunded"
                        ? "border-slate-700 text-slate-400"
                        : "border-amber-500/40 text-amber-200";

                  return (
                    <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-100">{item.quantity}x {name}</p>
                          <p className="text-xs text-slate-400">{variantText ?? "Sem variante"}</p>
                          <p className="mt-0.5 text-xs text-slate-500">{canViewFinancial ? money(item.final_amount ?? 0) : ""}</p>
                        </div>
                        <span className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${deliveryClass}`}>{deliveryLabel}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </AdminSection>
          ) : null}

          {payments?.length ? (
            <AdminSection title="Tentativas de pagamento">
              <div className="grid gap-2 sm:grid-cols-2">
                {payments.map((payment) => (
                  <AdminStatCard
                    key={payment.id}
                    compact
                    label={PAYMENT_METHOD_LABELS[payment.payment_method ?? ""] ?? payment.payment_method ?? "Pagamento"}
                    value={canViewFinancial ? money(payment.final_amount ?? 0) : "—"}
                    hint={`${COMMERCIAL_STATUS_LABELS[resolveCommercialStatus({ paymentStatus: payment.payment_status })] ?? payment.payment_status} · ${formatDateTimeBR(payment.created_at) ?? "—"}`}
                  />
                ))}
              </div>
            </AdminSection>
          ) : null}
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
