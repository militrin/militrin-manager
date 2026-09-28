import type { ParsedPublicOrderQuery, ParsedTicketDisplayCode } from "@/lib/display-reference";
import type { GLOBAL_SEARCH_GROUPS } from "./constants.ts";

export type GlobalSearchGroupId = (typeof GLOBAL_SEARCH_GROUPS)[number];

export type GlobalSearchKind =
  | "empty"
  | "too_short"
  | "email"
  | "cpf"
  | "phone"
  | "order"
  | "ticket"
  | "wristband"
  | "token"
  | "uuid"
  | "name";

export type ClassifiedAdminQuery = {
  raw: string;
  trimmed: string;
  token: string;
  kind: GlobalSearchKind;
  searchText: string;
  minChars: number;
  email: string | null;
  cpfDigits: string | null;
  phoneDigits: string | null;
  orderQuery: ParsedPublicOrderQuery | null;
  ticketCode: ParsedTicketDisplayCode | null;
  uuid: string | null;
  wristbandCode: string | null;
  nameNeedle: string | null;
};

export type GlobalSearchPermissions = {
  participantsView: boolean;
  ordersView: boolean;
  wristbandsView: boolean;
  canViewAmounts: boolean;
};

export type GlobalSearchHit = {
  id: string;
  group: GlobalSearchGroupId;
  title: string;
  subtitle: string | null;
  meta: string | null;
  statusLabel: string | null;
  statusKey: string | null;
  href: string | null;
  cta: string;
};

export type GlobalSearchGroup = {
  id: GlobalSearchGroupId;
  label: string;
  hits: GlobalSearchHit[];
  total: number;
  hasMore: boolean;
  moreHref: string | null;
};

export type GlobalSearchResult =
  | { status: "idle" }
  | { status: "too_short"; minChars: number; query: string }
  | { status: "empty"; query: string; groups: GlobalSearchGroup[] }
  | { status: "ok"; query: string; groups: GlobalSearchGroup[] }
  | { status: "error"; message: string };

export type GlobalSearchSourceRow = {
  id: string;
  [key: string]: unknown;
};
