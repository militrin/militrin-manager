import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { AdminEmptyState, AdminPageHeader, AdminSection, AdminStatCard, AdminStatusBadge } from "@/components/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getAdminAccessContext } from "@/lib/admin/access";
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
      .select("id,item_position,status,holder_full_name,holder_email,holder_phone,participant_id,quantity,unit_price,discount_amount,final_amount,shirt_type,shirt_size,reservation_expires_at,registration_batches(name),ticket_categories(name),participants(full_name,cpf,phone,email)")
      .eq("order_id", orderId)
      .order("item_position", { ascending: true }),
    supabase
      .from("payments")
      .select("id,payment_status,payment_method,final_amount,created_at,paid_at")
      .eq("order_id", orderId)
      .order("created_at", { ascending: false }),
    supabase.from("tickets").select("id,order_item_id").eq("order_id", orderId),
  ]);

  const ticketByItem = new Map((tickets ?? []).map((ticket) => [String(ticket.order_item_id ?? ""), ticket.id]));
  const latestPayment = (payments ?? [])[0] ?? null;

  let buyerName: string | null = null;
  if (order.user_id) {
    const { data: buyers } = await supabase.rpc("get_operation_buyers", { p_event_id: order.event_id });
    const buyer = ((buyers ?? []) as Array<Record<string, unknown>>).find((row) => String(row.user_id ?? "") === String(order.user_id));
    if (buyer?.full_name) buyerName = String(buyer.full_name);
  }

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
            subtitle={`${eventRelation?.name ?? "Evento"} · ${(items ?? []).length} item(ns)`}
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

          <AdminSection title={`Ingresso(s) do pedido (${(items ?? []).length})`}>
            {!items?.length ? <AdminEmptyState title="Nenhum item encontrado" description="Este pedido não tem itens registrados." /> : (
              <div className="space-y-2">
                {items.map((item) => {
                  const participant = one(item.participants);
                  const ticketId = ticketByItem.get(String(item.id));
                  const category = one(item.ticket_categories);
                  const batch = one(item.registration_batches);
                  const name = item.holder_full_name ?? participant?.full_name ?? "Titular não definido";
                  return (
                    <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm">
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
                        </div>
                        {ticketId ? (
                          <Link href={`/ingressos/${ticketId}`} className="inline-flex h-8 shrink-0 items-center rounded-lg border border-cyan-500/40 px-2.5 text-xs text-cyan-200">
                            Ver ingresso
                          </Link>
                        ) : (
                          <span className="shrink-0 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400">Ingresso não emitido</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </AdminSection>

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
