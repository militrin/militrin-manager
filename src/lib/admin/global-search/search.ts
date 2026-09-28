import { GLOBAL_SEARCH_GROUP_LIMIT, GLOBAL_SEARCH_NAME_MIN_CHARS } from "./constants.ts";
import { classifyAdminSearchQuery, personSearchKinds } from "./classify.ts";
import { sanitizeSearchError } from "./errors.ts";
import { flattenSearchHits, toSearchGroup } from "./present.ts";
import {
  moreHrefFor,
  searchOrderById,
  searchOrdersByIdentifier,
  searchOrdersByName,
  searchOrdersRelated,
  searchPeopleSource,
  searchTicketsRelated,
  searchTicketsSource,
  searchWristbandsForTicketIds,
  searchWristbandsSource,
} from "./sources.ts";
import type {
  ClassifiedAdminQuery,
  GlobalSearchGroup,
  GlobalSearchHit,
  GlobalSearchResult,
} from "./types.ts";
import type { GlobalSearchContext } from "./sources.ts";

function uniqueHits(hits: GlobalSearchHit[]) {
  const seen = new Set<string>();
  const out: GlobalSearchHit[] = [];
  for (const hit of hits) {
    const key = `${hit.group}:${hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function pushGroup(
  groups: GlobalSearchGroup[],
  id: GlobalSearchGroup["id"],
  hits: GlobalSearchHit[],
  total: number,
  classified: ClassifiedAdminQuery,
  permissions: GlobalSearchContext["permissions"],
) {
  const unique = uniqueHits(hits).slice(0, GLOBAL_SEARCH_GROUP_LIMIT);
  if (!unique.length) return;
  groups.push(toSearchGroup(
    id,
    unique,
    Math.max(total, unique.length),
    moreHrefFor(classified.kind, classified.trimmed, id, permissions),
  ));
}

export async function executeGlobalSearch(rawQuery: string, ctx: GlobalSearchContext): Promise<GlobalSearchResult> {
  const classified = classifyAdminSearchQuery(rawQuery);
  if (classified.kind === "empty") return { status: "idle" };
  if (classified.kind === "too_short") {
    return { status: "too_short", minChars: classified.minChars || GLOBAL_SEARCH_NAME_MIN_CHARS, query: classified.trimmed };
  }

  const canReadTickets = ctx.permissions.participantsView || ctx.permissions.ordersView;
  const groups: GlobalSearchGroup[] = [];

  try {
    const peoplePromise = ctx.permissions.participantsView && personSearchKinds(classified.kind)
      ? searchPeopleSource(ctx, classified)
      : Promise.resolve({ hits: [] as GlobalSearchHit[], total: 0, contacts: [] as Array<Record<string, unknown>> });

    const orderIdPromise = ctx.permissions.ordersView && classified.kind === "order"
      ? searchOrdersByIdentifier(ctx, classified)
      : Promise.resolve({ hits: [] as GlobalSearchHit[], total: 0, rows: [] as Record<string, unknown>[] });

    const ticketsPromise = canReadTickets && (classified.kind === "ticket" || classified.kind === "token" || classified.kind === "uuid" || classified.kind === "name")
      ? searchTicketsSource(ctx, classified)
      : Promise.resolve({ hits: [] as GlobalSearchHit[], total: 0, rows: [] as Array<{ ticketId: string; holderName: string; eventName: string }> });

    const wristbandPromise = ctx.permissions.wristbandsView && classified.kind === "wristband"
      ? searchWristbandsSource(ctx, classified, canReadTickets)
      : Promise.resolve({ hits: [] as GlobalSearchHit[], total: 0 });

    const [people, identifiedOrders, tickets, wristbands] = await Promise.all([
      peoplePromise,
      orderIdPromise,
      ticketsPromise,
      wristbandPromise,
    ]);

    const relatedOrderPromises: Array<Promise<{ hits: GlobalSearchHit[]; total: number }>> = [];
    if (ctx.permissions.ordersView && people.contacts?.length && personSearchKinds(classified.kind)) {
      relatedOrderPromises.push(searchOrdersRelated(ctx, people.contacts));
    }
    if (ctx.permissions.ordersView && classified.kind === "name" && ctx.permissions.participantsView) {
      relatedOrderPromises.push(searchOrdersByName(ctx, classified));
    }
    if (ctx.permissions.ordersView && classified.kind === "uuid" && classified.uuid) {
      relatedOrderPromises.push(searchOrderById(ctx, classified.uuid));
    }

    const relatedTicketsPromise = canReadTickets && ctx.permissions.participantsView && people.contacts?.length && personSearchKinds(classified.kind)
      ? searchTicketsRelated(ctx, people.contacts)
      : Promise.resolve({ hits: [] as GlobalSearchHit[], total: 0, rows: [] as Array<{ ticketId: string; holderName: string; eventName: string }> });

    const [relatedOrders, relatedTickets] = await Promise.all([
      relatedOrderPromises.length ? Promise.all(relatedOrderPromises) : Promise.resolve([] as Array<{ hits: GlobalSearchHit[]; total: number }>),
      relatedTicketsPromise,
    ]);

    const orderHits = [
      ...identifiedOrders.hits,
      ...relatedOrders.flatMap((entry) => entry.hits),
    ];
    const orderTotal = Math.max(
      identifiedOrders.total,
      ...relatedOrders.map((entry) => entry.total),
      orderHits.length,
    );

    const ticketHits = uniqueHits([...tickets.hits, ...relatedTickets.hits]);
    const ticketTotal = Math.max(tickets.total, relatedTickets.total, ticketHits.length);
    const mergedTicketRows = [
      ...tickets.rows,
      ...relatedTickets.rows,
    ].filter((row, index, all) => all.findIndex((entry) => entry.ticketId === row.ticketId) === index);

    if (ctx.permissions.wristbandsView && classified.kind === "token") {
      const fromCode = await searchWristbandsSource(ctx, { ...classified, wristbandCode: classified.token, kind: "wristband" }, canReadTickets);
      wristbands.hits.push(...fromCode.hits);
      wristbands.total += fromCode.total;
    }

    const ticketWristbands = ctx.permissions.wristbandsView
      ? await searchWristbandsForTicketIds(ctx, mergedTicketRows, canReadTickets)
      : { hits: [] as GlobalSearchHit[], total: 0 };

    pushGroup(groups, "people", people.hits, people.total, classified, ctx.permissions);
    pushGroup(groups, "orders", orderHits, orderTotal, classified, ctx.permissions);
    pushGroup(groups, "tickets", ticketHits, ticketTotal, classified, ctx.permissions);
    pushGroup(groups, "wristbands", [...wristbands.hits, ...ticketWristbands.hits], wristbands.total + ticketWristbands.total, classified, ctx.permissions);

    if (!groups.length) return { status: "empty", query: classified.trimmed, groups: [] };
    return { status: "ok", query: classified.trimmed, groups };
  } catch (error) {
    return {
      status: "error",
      message: sanitizeSearchError(error),
    };
  }
}

export { flattenSearchHits };
