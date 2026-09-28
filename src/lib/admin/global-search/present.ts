import { contactAccountStateView, type ContactAccountState } from "../../account/contact-account-state.ts";
import { formatImportedHistoricalAmount } from "../../imports/legacy-price.ts";
import { presentSupportOrderFromRecord, type SupportOrderPresentation } from "../../orders/support-presentation.ts";
import { getStatusLabel } from "../../status-labels.ts";
import { formatDisplayNumber } from "../../display-reference.ts";
import { GLOBAL_SEARCH_GROUP_LABELS, WRISTBAND_STATUS_LABELS } from "./constants.ts";
import { formatSearchStatus, maskCpfForSearch, maskWristbandForSearch } from "./mask.ts";
import type { GlobalSearchGroup, GlobalSearchGroupId, GlobalSearchHit } from "./types.ts";

const ACCOUNT_STATES = new Set<ContactAccountState>([
  "active",
  "pending_confirmation",
  "existing_confirmed",
  "none",
  "attention",
  "linked_to_other_account",
]);

export function accountStateLabel(state: string | null | undefined, fallbackUserId?: string | null) {
  const normalized = String(state ?? "").trim() as ContactAccountState;
  if (ACCOUNT_STATES.has(normalized)) return contactAccountStateView(normalized).label;
  return fallbackUserId ? contactAccountStateView("active").label : contactAccountStateView("none").label;
}

export function presentPersonHit(input: {
  id: string;
  name: string;
  cpf?: string | null;
  city?: string | null;
  accountState?: string | null;
  userId?: string | null;
  distinguishWithCity?: boolean;
}): GlobalSearchHit {
  const cpfLine = input.cpf ? `CPF ${maskCpfForSearch(input.cpf)}` : null;
  const account = `Conta: ${accountStateLabel(input.accountState, input.userId).toLocaleLowerCase("pt-BR")}`;
  return {
    id: input.id,
    group: "people",
    title: input.name,
    subtitle: cpfLine,
    meta: input.distinguishWithCity && input.city ? `${account} · ${input.city}` : account,
    statusLabel: null,
    statusKey: null,
    href: `/cadastros/${input.id}`,
    cta: "Ver cadastro",
  };
}

export function presentOrderHit(input: {
  row: Record<string, unknown>;
  buyerName?: string | null;
  now?: Date;
  showAmount?: boolean;
}): GlobalSearchHit {
  const presented = presentSupportOrderFromRecord(input.row, { now: input.now });
  return presentOrderFromSupport(presented, {
    buyerName: input.buyerName,
    orderId: String(input.row.id ?? presented.orderId),
    priceOrigin: input.row.price_origin ? String(input.row.price_origin) : null,
    showAmount: input.showAmount,
  });
}

export function presentOrderFromSupport(
  presented: SupportOrderPresentation,
  extras: { buyerName?: string | null; orderId: string; priceOrigin?: string | null; showAmount?: boolean },
): GlobalSearchHit {
  const amount = extras.showAmount === false
    ? null
    : formatImportedHistoricalAmount(
      presented.chargedAmount ?? presented.afterDiscountAmount,
      extras.priceOrigin,
    );
  const method = presented.methodLabel && presented.methodLabel !== "—"
    ? presented.methodLabel
    : presented.formaLabel;
  return {
    id: extras.orderId,
    group: "orders",
    title: presented.orderNumber.startsWith("#") || presented.orderNumber.startsWith("MIL-")
      ? presented.orderNumber
      : formatDisplayNumber(presented.orderNumber) ?? presented.orderNumber,
    subtitle: String(extras.buyerName ?? "").trim() || null,
    meta: [method, amount].filter((part) => part && part !== "—").join(" · ") || null,
    statusLabel: formatSearchStatus(getStatusLabel(presented.situationBadge)),
    statusKey: presented.situationBadge,
    href: `/inscricoes/pedido/${extras.orderId}`,
    cta: "Ver pedido",
  };
}

export function presentTicketHit(input: {
  ticketId: string;
  ticketReference: string;
  holderName: string;
  categoryName?: string | null;
  eventName?: string | null;
  status: string;
}): GlobalSearchHit {
  return {
    id: input.ticketId,
    group: "tickets",
    title: input.ticketReference,
    subtitle: input.holderName,
    meta: [input.categoryName, input.eventName].filter(Boolean).join(" · ") || null,
    statusLabel: formatSearchStatus(getStatusLabel(input.status)),
    statusKey: input.status,
    href: `/ingressos/${input.ticketId}`,
    cta: "Ver ingresso",
  };
}

export function presentWristbandHit(input: {
  id: string;
  code: string;
  status: string;
  holderName?: string | null;
  eventName?: string | null;
  ticketId?: string | null;
  canOpenTicket: boolean;
}): GlobalSearchHit {
  const statusLabel = formatSearchStatus(WRISTBAND_STATUS_LABELS[String(input.status).toLowerCase()] ?? input.status);
  return {
    id: input.id,
    group: "wristbands",
    title: maskWristbandForSearch(input.code),
    subtitle: input.holderName ?? null,
    meta: input.eventName ?? null,
    statusLabel,
    statusKey: null,
    href: input.canOpenTicket && input.ticketId ? `/ingressos/${input.ticketId}` : null,
    cta: input.canOpenTicket && input.ticketId ? "Ver ingresso" : "Pulseira",
  };
}

export function toSearchGroup(
  id: GlobalSearchGroupId,
  hits: GlobalSearchHit[],
  total: number,
  moreHref: string | null,
): GlobalSearchGroup {
  return {
    id,
    label: GLOBAL_SEARCH_GROUP_LABELS[id],
    hits,
    total,
    hasMore: total > hits.length,
    moreHref: total > hits.length ? moreHref : null,
  };
}

export function flattenSearchHits(groups: GlobalSearchGroup[]) {
  return groups.flatMap((group) => {
    const items = [...group.hits];
    if (group.hasMore && group.moreHref) {
      items.push({
        id: `more:${group.id}`,
        group: group.id,
        title: "Ver mais resultados",
        subtitle: null,
        meta: group.label,
        statusLabel: null,
        statusKey: null,
        href: group.moreHref,
        cta: "Ver mais",
      });
    }
    return items;
  });
}
