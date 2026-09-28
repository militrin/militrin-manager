import { formatCpf } from "../../validation/registration.ts";
import { removeAccents } from "../../imports/normalization.ts";
import { ticketDisplayReference } from "../../display-reference.ts";
import {
  GLOBAL_SEARCH_FETCH_CAP,
  GLOBAL_SEARCH_GROUP_LIMIT,
} from "./constants.ts";
import {
  classifyAdminSearchQuery,
  escapeIlikePattern,
  nameMatchesQuery,
  phoneDigitsMatch,
} from "./classify.ts";
import {
  presentOrderHit,
  presentPersonHit,
  presentTicketHit,
  presentWristbandHit,
} from "./present.ts";
import type {
  ClassifiedAdminQuery,
  GlobalSearchHit,
  GlobalSearchPermissions,
} from "./types.ts";

type SearchClient = {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type GlobalSearchContext = {
  supabase: SearchClient;
  organizationId: string;
  permissions: GlobalSearchPermissions;
  now?: Date;
};

const TICKET_SELECT = `
  id, status,
  events(name),
  order_items(holder_full_name, item_position, ticket_categories(name)),
  orders(display_number, order_number)
`.replace(/\s+/g, " ").trim();

const ORDER_SELECT_COMMERCIAL = `
  id, order_number, display_number, status, buyer_type, user_id,
  base_amount, discount_amount, final_amount, price_origin, created_at,
  payments!payments_order_id_fkey(
    payment_method, payment_status, expires_at, created_at, paid_at,
    final_amount, payment_fee_customer_amount, settlement_nature, provider,
    gateway_payment_id, gateway_account_key, gateway_environment,
    off_gateway_method, off_gateway_amount, off_gateway_recorded_at
  )
`.replace(/\s+/g, " ").trim();

const ORDER_SELECT_WITH_BUYER = ORDER_SELECT_COMMERCIAL.replace(
  "created_at, payments!",
  "created_at, participants(full_name), payments!",
);

function orderSelect(includeBuyer: boolean) {
  return includeBuyer ? ORDER_SELECT_WITH_BUYER : ORDER_SELECT_COMMERCIAL;
}

function includeBuyerIdentity(ctx: GlobalSearchContext) {
  return ctx.permissions.participantsView;
}

function showOrderAmount(ctx: GlobalSearchContext) {
  return ctx.permissions.canViewAmounts;
}

function relation(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as Record<string, unknown> | undefined) ?? null;
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function buyerNameFromOrder(row: Record<string, unknown>) {
  const participant = relation(row.participants);
  return String(participant?.full_name ?? "").trim() || null;
}

function nameIlikeVariants(term: string) {
  const trimmed = term.trim();
  const folded = removeAccents(trimmed);
  return [...new Set([trimmed, folded].filter(Boolean))];
}

function limitHits(hits: GlobalSearchHit[], limit = GLOBAL_SEARCH_GROUP_LIMIT) {
  return hits.slice(0, limit);
}

function uniqueById<T extends { id: string }>(rows: T[]) {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function moreHrefFor(
  _kind: ClassifiedAdminQuery["kind"],
  query: string,
  group: "people" | "orders" | "tickets" | "wristbands",
  permissions?: GlobalSearchPermissions,
) {
  const q = encodeURIComponent(query);
  if (group === "people") return `/cadastros?q=${q}`;
  if (group === "orders") return `/pedidos?q=${q}`;
  if (group === "tickets") return `/ingressos?situacao=todos&q=${q}`;
  if (group === "wristbands") {
    const canReadTickets = Boolean(permissions?.participantsView || permissions?.ordersView);
    return canReadTickets ? `/ingressos?situacao=todos&q=${q}` : null;
  }
  return null;
}

export async function searchPeopleSource(ctx: GlobalSearchContext, classified: ClassifiedAdminQuery) {
  const { supabase, organizationId } = ctx;
  const kind = classified.kind;
  if (!["name", "cpf", "email", "phone", "uuid"].includes(kind)) return { hits: [] as GlobalSearchHit[], total: 0 };

  let request = supabase
    .from("registration_contacts")
    .select("id, full_name, cpf, email, phone, city, user_id")
    .eq("organization_id", organizationId)
    .limit(GLOBAL_SEARCH_FETCH_CAP);

  if (kind === "cpf" && classified.cpfDigits) {
    const formatted = formatCpf(classified.cpfDigits);
    request = request.or(`cpf.eq.${classified.cpfDigits},cpf.eq.${formatted}`);
  } else if (kind === "email" && classified.email) {
    request = request.ilike("email", escapeIlikePattern(classified.email));
  } else if (kind === "phone" && classified.phoneDigits) {
    request = request.ilike("phone", `%${escapeIlikePattern(classified.phoneDigits.slice(-8))}%`);
  } else if (kind === "uuid" && classified.uuid) {
    request = request.eq("id", classified.uuid);
  } else if (kind === "name") {
    const orExpr = nameIlikeVariants(classified.trimmed)
      .map((variant) => `full_name.ilike.%${escapeIlikePattern(variant)}%`)
      .join(",");
    request = request.or(orExpr);
  }

  const { data, error } = await request;
  if (error) throw error;

  let rows = ((data ?? []) as Array<Record<string, unknown>>).filter((row) => {
    if (kind === "name") return nameMatchesQuery(String(row.full_name ?? ""), classified.trimmed);
    if (kind === "phone" && classified.phoneDigits) return phoneDigitsMatch(String(row.phone ?? ""), classified.phoneDigits);
    if (kind === "cpf" && classified.cpfDigits) {
      return String(row.cpf ?? "").replace(/\D/g, "") === classified.cpfDigits;
    }
    if (kind === "email" && classified.email) {
      return String(row.email ?? "").trim().toLowerCase() === classified.email;
    }
    return true;
  });

  const nameCounts = new Map<string, number>();
  for (const row of rows) {
    const key = String(row.full_name ?? "").trim().toLocaleLowerCase("pt-BR");
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const total = rows.length;
  rows = rows.slice(0, GLOBAL_SEARCH_GROUP_LIMIT);
  const hits = rows.map((row) => {
    const name = String(row.full_name ?? "").trim() || "Sem nome";
    return presentPersonHit({
      id: String(row.id),
      name,
      cpf: row.cpf ? String(row.cpf) : null,
      city: row.city ? String(row.city) : null,
      accountState: row.user_id ? "active" : "none",
      userId: row.user_id ? String(row.user_id) : null,
      distinguishWithCity: (nameCounts.get(name.toLocaleLowerCase("pt-BR")) ?? 0) > 1,
    });
  });

  return { hits, total, contacts: rows };
}

export async function searchOrdersByIdentifier(ctx: GlobalSearchContext, classified: ClassifiedAdminQuery) {
  const { supabase, organizationId, now } = ctx;
  const parsed = classified.orderQuery;
  if (!parsed) return { hits: [] as GlobalSearchHit[], total: 0, rows: [] as Record<string, unknown>[] };

  const includeBuyer = includeBuyerIdentity(ctx);
  let request = supabase
    .from("orders")
    .select(orderSelect(includeBuyer))
    .eq("organization_id", organizationId)
    .limit(GLOBAL_SEARCH_FETCH_CAP);

  if (parsed.kind === "mil") {
    request = request.or(`order_number.eq.${parsed.canonical},display_number.eq.${parsed.sequence}`);
  } else {
    request = request.eq("display_number", parsed.sequence);
  }

  const { data, error } = await request;
  if (error) throw error;
  const rows = uniqueById(((data ?? []) as Array<Record<string, unknown>>).map((row) => ({ ...row, id: String(row.id) })));
  const hits = rows.map((row) => presentOrderHit({
    row,
    buyerName: includeBuyer ? buyerNameFromOrder(row) : null,
    now,
    showAmount: showOrderAmount(ctx),
  }));
  return { hits: limitHits(hits), total: rows.length, rows };
}

export async function searchOrderById(ctx: GlobalSearchContext, orderId: string) {
  const { supabase, organizationId, now } = ctx;
  const includeBuyer = includeBuyerIdentity(ctx);
  const { data, error } = await supabase
    .from("orders")
    .select(orderSelect(includeBuyer))
    .eq("organization_id", organizationId)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { hits: [] as GlobalSearchHit[], total: 0 };
  const row = data as Record<string, unknown>;
  return {
    hits: [presentOrderHit({
      row,
      buyerName: includeBuyer ? buyerNameFromOrder(row) : null,
      now,
      showAmount: showOrderAmount(ctx),
    })],
    total: 1,
  };
}

export async function searchOrdersRelated(ctx: GlobalSearchContext, contactRows: Array<Record<string, unknown>>) {
  const { supabase, organizationId, now } = ctx;
  if (!contactRows.length || !includeBuyerIdentity(ctx)) return { hits: [] as GlobalSearchHit[], total: 0 };
  const includeBuyer = true;

  const userIds = contactRows.map((row) => row.user_id ? String(row.user_id) : "").filter(Boolean);
  const contactIds = contactRows.map((row) => String(row.id));
  const collected: Record<string, unknown>[] = [];

  if (userIds.length) {
    const { data, error } = await supabase
      .from("orders")
      .select(orderSelect(includeBuyer))
      .eq("organization_id", organizationId)
      .in("user_id", userIds)
      .order("created_at", { ascending: false })
      .limit(GLOBAL_SEARCH_FETCH_CAP);
    if (error) throw error;
    collected.push(...((data ?? []) as Array<Record<string, unknown>>));
  }

  const { data: itemRows, error: itemsError } = await supabase
    .from("order_items")
    .select("order_id, registration_contact_id")
    .in("registration_contact_id", contactIds)
    .limit(GLOBAL_SEARCH_FETCH_CAP);
  if (itemsError) throw itemsError;
  const orderIds = [...new Set((itemRows ?? []).map((row: { order_id?: string }) => String(row.order_id ?? "")).filter(Boolean))];
  if (orderIds.length) {
    const { data, error } = await supabase
      .from("orders")
      .select(orderSelect(includeBuyer))
      .eq("organization_id", organizationId)
      .in("id", orderIds)
      .limit(GLOBAL_SEARCH_FETCH_CAP);
    if (error) throw error;
    collected.push(...((data ?? []) as Array<Record<string, unknown>>));
  }

  const rows = uniqueById(collected.map((row) => ({ ...row, id: String(row.id) })));
  const hits = rows.map((row) => presentOrderHit({
    row,
    buyerName: buyerNameFromOrder(row),
    now,
    showAmount: showOrderAmount(ctx),
  }));
  return { hits: limitHits(hits), total: rows.length };
}

export async function searchOrdersByName(ctx: GlobalSearchContext, classified: ClassifiedAdminQuery) {
  const { supabase, organizationId, now } = ctx;
  if (!includeBuyerIdentity(ctx)) return { hits: [] as GlobalSearchHit[], total: 0 };
  const orExpr = nameIlikeVariants(classified.trimmed)
    .map((variant) => `full_name.ilike.%${escapeIlikePattern(variant)}%`)
    .join(",");
  const { data, error } = await supabase
    .from("participants")
    .select(`id, full_name, orders!inner(${orderSelect(true)})`)
    .eq("organization_id", organizationId)
    .or(orExpr)
    .limit(GLOBAL_SEARCH_FETCH_CAP);
  if (error) throw error;

  const rows: Record<string, unknown>[] = [];
  for (const participant of (data ?? []) as Array<Record<string, unknown>>) {
    if (!nameMatchesQuery(String(participant.full_name ?? ""), classified.trimmed)) continue;
    const orders = Array.isArray(participant.orders) ? participant.orders : participant.orders ? [participant.orders] : [];
    for (const order of orders as Array<Record<string, unknown>>) {
      rows.push({ ...order, participants: { full_name: participant.full_name } });
    }
  }
  const unique = uniqueById(rows.map((row) => ({ ...row, id: String(row.id) })));
  const hits = unique.map((row) => presentOrderHit({
    row,
    buyerName: buyerNameFromOrder(row),
    now,
    showAmount: showOrderAmount(ctx),
  }));
  return { hits: limitHits(hits), total: unique.length };
}

function emptyTicketResult() {
  return { hits: [] as GlobalSearchHit[], total: 0, rows: [] as Array<{ ticketId: string; holderName: string; eventName: string }> };
}

function ticketHitFromRow(row: Record<string, unknown>): GlobalSearchHit {
  const item = relation(row.order_items);
  const order = relation(row.orders);
  const event = relation(row.events);
  const category = relation(item?.ticket_categories);
  const holderName = String(item?.holder_full_name ?? "").trim() || "Sem titular";
  return presentTicketHit({
    ticketId: String(row.id),
    ticketReference: ticketDisplayReference(order?.display_number, item?.item_position, order?.order_number),
    holderName,
    categoryName: category?.name ? String(category.name) : null,
    eventName: event?.name ? String(event.name) : null,
    status: String(row.status ?? ""),
  });
}

function ticketSourceResult(rows: Array<Record<string, unknown>>) {
  const unique = uniqueById(rows.map((row) => ({ ...row, id: String(row.id) })));
  const hits = unique.map((row) => ticketHitFromRow(row));
  return {
    hits: limitHits(hits),
    total: unique.length,
    rows: unique.map((row) => {
      const hit = ticketHitFromRow(row);
      return { ticketId: hit.id, holderName: hit.subtitle ?? "Sem titular", eventName: hit.meta ?? "" };
    }),
  };
}

export async function searchTicketsSource(ctx: GlobalSearchContext, classified: ClassifiedAdminQuery) {
  const { supabase, organizationId } = ctx;
  const kind = classified.kind;

  if (kind === "ticket" && classified.ticketCode) {
    const { data, error } = await supabase
      .from("tickets")
      .select(`id, status, events(name), order_items!inner(holder_full_name, item_position, ticket_categories(name)), orders!inner(display_number, order_number)`)
      .eq("organization_id", organizationId)
      .eq("orders.display_number", classified.ticketCode.displayNumber)
      .eq("order_items.item_position", classified.ticketCode.itemPosition)
      .limit(GLOBAL_SEARCH_FETCH_CAP);
    if (error) throw error;
    return ticketSourceResult((data ?? []) as Array<Record<string, unknown>>);
  }

  if (kind === "uuid" || kind === "token") {
    const token = classified.uuid || classified.token || classified.searchText;
    if (!token) return emptyTicketResult();
    let request = supabase
      .from("tickets")
      .select(TICKET_SELECT)
      .eq("organization_id", organizationId)
      .limit(GLOBAL_SEARCH_FETCH_CAP);
    request = classified.uuid || /^[0-9a-f-]{36}$/i.test(token)
      ? request.or(`id.eq.${token},token.eq.${token}`)
      : request.eq("token", token);
    const { data, error } = await request;
    if (error) throw error;
    return ticketSourceResult((data ?? []) as Array<Record<string, unknown>>);
  }

  if (kind === "name") {
    const orExpr = nameIlikeVariants(classified.trimmed)
      .map((variant) => `holder_full_name.ilike.%${escapeIlikePattern(variant)}%`)
      .join(",");
    const { data, error } = await supabase
      .from("tickets")
      .select(`id, status, events(name), order_items!inner(holder_full_name, item_position, ticket_categories(name)), orders(display_number, order_number)`)
      .eq("organization_id", organizationId)
      .or(orExpr, { referencedTable: "order_items" })
      .limit(GLOBAL_SEARCH_FETCH_CAP);
    if (error) throw error;
    const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((row) => {
      const item = relation(row.order_items);
      return nameMatchesQuery(String(item?.holder_full_name ?? ""), classified.trimmed);
    });
    return ticketSourceResult(rows);
  }

  return emptyTicketResult();
}

export async function searchTicketsRelated(ctx: GlobalSearchContext, contactRows: Array<Record<string, unknown>>) {
  if (!contactRows.length || !ctx.permissions.participantsView) return emptyTicketResult();
  const contactIds = contactRows.map((row) => String(row.id)).filter(Boolean);
  if (!contactIds.length) return emptyTicketResult();
  const { data, error } = await ctx.supabase
    .from("tickets")
    .select(`id, status, events(name), order_items!inner(holder_full_name, item_position, registration_contact_id, ticket_categories(name)), orders(display_number, order_number)`)
    .eq("organization_id", ctx.organizationId)
    .in("order_items.registration_contact_id", contactIds)
    .limit(GLOBAL_SEARCH_FETCH_CAP);
  if (error) throw error;
  return ticketSourceResult((data ?? []) as Array<Record<string, unknown>>);
}

async function ticketHolderNames(ctx: GlobalSearchContext, ticketIds: string[], canOpenTicket: boolean) {
  const holders = new Map<string, string>();
  if (!ticketIds.length || !canOpenTicket) return holders;
  const { data, error } = await ctx.supabase
    .from("tickets")
    .select("id, order_items(holder_full_name)")
    .eq("organization_id", ctx.organizationId)
    .in("id", ticketIds);
  if (error) throw error;
  for (const ticket of (data ?? []) as Array<Record<string, unknown>>) {
    const name = String(relation(ticket.order_items)?.holder_full_name ?? "").trim();
    if (name) holders.set(String(ticket.id), name);
  }
  return holders;
}

export async function searchWristbandsSource(ctx: GlobalSearchContext, classified: ClassifiedAdminQuery, canOpenTicket: boolean) {
  const { supabase, organizationId } = ctx;
  const code = classified.wristbandCode ?? classified.token;
  if (!code) return { hits: [] as GlobalSearchHit[], total: 0 };

  const { data, error } = await supabase
    .from("participant_wristbands")
    .select("id, code, status, ticket_id, event_id, events(name)")
    .eq("organization_id", organizationId)
    .ilike("code", escapeIlikePattern(code))
    .limit(GLOBAL_SEARCH_FETCH_CAP);
  if (error) throw error;

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const ticketIds = rows.map((row) => row.ticket_id ? String(row.ticket_id) : "").filter(Boolean);
  const holders = await ticketHolderNames(ctx, ticketIds, canOpenTicket);

  const hits = rows.map((row) => {
    const event = relation(row.events);
    const ticketId = row.ticket_id ? String(row.ticket_id) : null;
    return presentWristbandHit({
      id: String(row.id),
      code: String(row.code ?? code),
      status: String(row.status ?? ""),
      holderName: ticketId ? holders.get(ticketId) ?? null : null,
      eventName: event?.name ? String(event.name) : null,
      ticketId,
      canOpenTicket,
    });
  });
  return { hits: limitHits(hits), total: rows.length };
}

export async function searchWristbandsForTicketIds(
  ctx: GlobalSearchContext,
  tickets: Array<{ ticketId: string; holderName: string; eventName: string }>,
  canOpenTicket: boolean,
) {
  const ticketIds = tickets.map((row) => row.ticketId).filter(Boolean);
  if (!ticketIds.length) return { hits: [] as GlobalSearchHit[], total: 0 };
  const { data, error } = await ctx.supabase
    .from("participant_wristbands")
    .select("id, code, status, ticket_id, event_id, events(name)")
    .eq("organization_id", ctx.organizationId)
    .in("ticket_id", ticketIds)
    .eq("status", "active")
    .limit(GLOBAL_SEARCH_FETCH_CAP);
  if (error) throw error;
  const byTicket = new Map(tickets.map((row) => [row.ticketId, row]));
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hits = rows.map((row) => {
    const ticketId = row.ticket_id ? String(row.ticket_id) : null;
    const related = ticketId ? byTicket.get(ticketId) : null;
    const event = relation(row.events);
    return presentWristbandHit({
      id: String(row.id),
      code: String(row.code ?? ""),
      status: String(row.status ?? "active"),
      holderName: related?.holderName ?? null,
      eventName: related?.eventName || (event?.name ? String(event.name) : null),
      ticketId,
      canOpenTicket,
    });
  });
  return { hits: limitHits(hits), total: rows.length };
}

export { moreHrefFor, classifyAdminSearchQuery };
