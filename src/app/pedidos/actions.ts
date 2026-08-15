"use server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";
import type { OrderRow, OrderItemRow, OrdersFilterInput } from "./types";
import { ORDER_PAGE_SIZE } from "./types";

export type OrdersResult = {
  events: { id: string; name: string; is_active: boolean }[];
  selectedEvent: { id: string; name: string } | null;
  rows: OrderRow[];
  page: number;
  totalPages: number;
  totalFiltered: number;
  canViewAmounts: boolean;
};

export async function listOrdersAction(params: OrdersFilterInput): Promise<OrdersResult> {
  await assertPermission("orders.view");

  const supabase = await createServerSupabaseClient();

  const { data: eventsData } = await supabase
    .from("events")
    .select("id, name, is_active")
    .order("is_active", { ascending: false })
    .order("starts_at", { ascending: false });

  const events = (eventsData ?? []).map((e) => ({
    id: String(e.id),
    name: String(e.name),
    is_active: Boolean(e.is_active),
  }));

  const selectedEvent = params.eventId ? events.find((e) => e.id === params.eventId) ?? null : null;

  if (!selectedEvent) {
    return { events, selectedEvent: null, rows: [], page: 1, totalPages: 1, totalFiltered: 0, canViewAmounts: false };
  }

  // Verifica permissão de valores financeiros
  const { data: amountsData } = await supabase.rpc("current_user_has_permission", {
    p_permission_code: "finance.view_amounts",
  });
  const canViewAmounts = Boolean(amountsData);

  // ── 1. Pedidos com comprador ─────────────────────────────────────────
  const { data: ordersRaw } = await supabase
    .from("orders")
    .select(`
      id, order_number, status,
      base_amount, discount_amount, final_amount,
      created_at, confirmed_at,
      participants!inner(id, full_name, email, phone, cpf)
    `)
    .eq("event_id", selectedEvent.id)
    .order("created_at", { ascending: false })
    .limit(500);

  if (!ordersRaw?.length) {
    return { events, selectedEvent, rows: [], page: 1, totalPages: 1, totalFiltered: 0, canViewAmounts };
  }

  const orderIds = ordersRaw.map((o) => String(o.id));

  // ── 2. Pagamentos em lote ────────────────────────────────────────────
  const { data: paymentsRaw } = await supabase
    .from("payments")
    .select("order_id, payment_method, payment_status, final_amount")
    .in("order_id", orderIds)
    .order("created_at", { ascending: false });

  const paymentByOrder = new Map<string, { method: string | null; status: string }>();
  for (const p of paymentsRaw ?? []) {
    const oid = String(p.order_id ?? "");
    if (!paymentByOrder.has(oid)) {
      paymentByOrder.set(oid, {
        method: p.payment_method ? String(p.payment_method) : null,
        status: String(p.payment_status ?? "pending"),
      });
    }
  }

  // ── 3. Order items em lote ───────────────────────────────────────────
  const { data: itemsRaw } = await supabase
    .from("order_items")
    .select(`
      id, order_id, item_position, ownership_status, holder_full_name,
      ticket_categories(name),
      tickets(id, status, token)
    `)
    .in("order_id", orderIds)
    .order("item_position", { ascending: true });

  const itemsByOrder = new Map<string, OrderItemRow[]>();
  for (const item of itemsRaw ?? []) {
    const oid = String(item.order_id ?? "");
    const cat = item.ticket_categories as { name?: string } | null;
    const tkt = Array.isArray(item.tickets) ? item.tickets[0] : (item.tickets as { id?: string; status?: string; token?: string } | null);

    const row: OrderItemRow = {
      id: String(item.id),
      itemPosition: Number(item.item_position ?? 0),
      holderName: item.holder_full_name ? String(item.holder_full_name) : null,
      categoryName: cat?.name ? String(cat.name) : null,
      ticketId: tkt?.id ? String(tkt.id) : null,
      ticketStatus: tkt?.status ? String(tkt.status) : null,
      ticketToken: tkt?.token ? String(tkt.token) : null,
      ownershipStatus: String(item.ownership_status ?? "unassigned"),
    };

    if (!itemsByOrder.has(oid)) itemsByOrder.set(oid, []);
    itemsByOrder.get(oid)!.push(row);
  }

  // ── 4. Agrega linhas finais ──────────────────────────────────────────
  let rows: OrderRow[] = ordersRaw.map((o) => {
    const oid = String(o.id);
    const buyer = Array.isArray(o.participants)
      ? (o.participants[0] as Record<string, unknown>)
      : (o.participants as Record<string, unknown> | null);
    const payment = paymentByOrder.get(oid) ?? { method: null, status: "pending" };
    const items = itemsByOrder.get(oid) ?? [];
    const categoryNames = [...new Set(items.map((i) => i.categoryName).filter(Boolean))] as string[];

    return {
      id: oid,
      orderNumber: String(o.order_number ?? ""),
      buyerName: buyer?.full_name ? String(buyer.full_name) : "—",
      buyerEmail: buyer?.email ? String(buyer.email) : "",
      buyerPhone: buyer?.phone ? String(buyer.phone) : "",
      buyerCpf: buyer?.cpf ? String(buyer.cpf) : "",
      eventId: selectedEvent.id,
      status: String(o.status ?? "pending"),
      baseAmount: Number(o.base_amount ?? 0),
      discountAmount: Number(o.discount_amount ?? 0),
      finalAmount: Number(o.final_amount ?? 0),
      createdAt: String(o.created_at ?? ""),
      confirmedAt: o.confirmed_at ? String(o.confirmed_at) : null,
      paymentMethod: payment.method,
      paymentStatus: payment.status,
      ticketCount: items.length,
      categoryNames,
      hasDiscount: Number(o.discount_amount ?? 0) > 0,
      items,
    };
  });

  // Filtros
  const q = params.q?.toLowerCase().trim() ?? "";
  if (q) {
    rows = rows.filter(
      (r) =>
        r.orderNumber.toLowerCase().includes(q) ||
        r.buyerName.toLowerCase().includes(q) ||
        r.buyerEmail.toLowerCase().includes(q) ||
        r.buyerCpf.replace(/\D/g, "").includes(q.replace(/\D/g, "")),
    );
  }
  if (params.paymentStatus) rows = rows.filter((r) => r.paymentStatus === params.paymentStatus);
  if (params.orderStatus) rows = rows.filter((r) => r.status === params.orderStatus);

  const totalFiltered = rows.length;
  const page = Math.max(1, Number(params.page ?? 1));
  const totalPages = Math.max(1, Math.ceil(totalFiltered / ORDER_PAGE_SIZE));
  rows = rows.slice((page - 1) * ORDER_PAGE_SIZE, page * ORDER_PAGE_SIZE);

  return { events, selectedEvent, rows, page, totalPages, totalFiltered, canViewAmounts };
}
