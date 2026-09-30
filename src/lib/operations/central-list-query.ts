import { ticketMatchesExactDisplayCode } from "../display-reference.ts";

export const CENTRAL_DEFAULT_PAGE_SIZE = 50;
export const CENTRAL_MIN_PAGE_SIZE = 25;
export const CENTRAL_MAX_PAGE_SIZE = 100;

export type CentralListSortField =
  | "name"
  | "city"
  | "gender"
  | "age"
  | "shirt_type"
  | "shirt_size"
  | "payment"
  | "kit"
  | "checkin"
  | "wristband";

export type CentralListSortDirection = "asc" | "desc";

export type CentralListFilters = {
  search?: string;
  category?: string;
  city?: string;
  gender?: string;
  ageGroup?: string;
  paymentStatus?: string;
  kitStatus?: string;
  checkinStatus?: string;
  wristbandStatus?: string;
  shirtType?: string;
  shirtSize?: string;
  onlyPending?: boolean;
  sortField?: CentralListSortField;
  sortDirection?: CentralListSortDirection;
  page?: number;
  pageSize?: number;
};

export function clampCentralPageSize(value: unknown) {
  const parsed = Number(value ?? CENTRAL_DEFAULT_PAGE_SIZE);
  if (!Number.isFinite(parsed)) return CENTRAL_DEFAULT_PAGE_SIZE;
  return Math.min(CENTRAL_MAX_PAGE_SIZE, Math.max(CENTRAL_MIN_PAGE_SIZE, Math.trunc(parsed)));
}

export function clampCentralPage(value: unknown) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.trunc(parsed));
}

export function normalizeCentralSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function searchDigits(value: string) {
  return value.replace(/\D/g, "");
}

export function matchesCentralSearch(search: string, fields: Array<string | null | undefined>) {
  if (!search) return true;
  const haystack = normalizeCentralSearch(fields.filter(Boolean).join(" "));
  if (haystack.includes(search)) return true;
  const digitSearch = searchDigits(search);
  if (digitSearch.length < 3) return false;
  return searchDigits(fields.filter(Boolean).join(" ")).includes(digitSearch);
}

export function matchesTicketCentralSearch(
  search: string,
  row: { ticket_display_code?: string | null },
  extraFields: Array<string | null | undefined>,
) {
  const exact = ticketMatchesExactDisplayCode(search, row.ticket_display_code);
  if (exact !== null) return exact;
  return matchesCentralSearch(search, extraFields);
}

export function getCentralAge(birthDate: string | null | undefined) {
  if (!birthDate) return null;
  const date = new Date(birthDate);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const monthDiff = now.getMonth() - date.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < date.getDate())) age -= 1;
  return age >= 0 ? age : null;
}

export function inCentralAgeGroup(age: number | null, ageGroup: string | undefined) {
  if (!ageGroup || ageGroup === "all") return true;
  if (age === null) return false;
  if (ageGroup === "lt18") return age < 18;
  if (ageGroup === "18to29") return age >= 18 && age <= 29;
  if (ageGroup === "30to39") return age >= 30 && age <= 39;
  if (ageGroup === "40to49") return age >= 40 && age <= 49;
  if (ageGroup === "50plus") return age >= 50;
  return true;
}

export function isCentralTicketPending(input: {
  kind?: string | null;
  payment_kind?: string | null;
  checkin_status?: string | null;
  event_has_kit?: boolean;
  kit_status?: string | null;
  event_wristband_enabled?: boolean;
  wristband_status?: string | null;
}) {
  if (input.kind && input.kind !== "ticket") return false;
  if (input.payment_kind === "pending") return true;
  if (input.checkin_status !== "done") return true;
  if (input.event_has_kit && input.kit_status !== "delivered" && input.kit_status !== "none") return true;
  if (input.event_wristband_enabled && input.wristband_status !== "active") return true;
  return false;
}

export type CentralListFacets = {
  categories: string[];
  cities: string[];
  shirt_types: string[];
  shirt_sizes: string[];
};

export type CentralTicketPageResult = {
  ticket_ids: string[];
  filtered_count: number;
  operational_total: number;
  facets: CentralListFacets;
};

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

export function parseOperationTicketPage(data: unknown): CentralTicketPageResult {
  const row = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const facets = row.facets && typeof row.facets === "object" && !Array.isArray(row.facets)
    ? row.facets as Record<string, unknown>
    : {};
  return {
    ticket_ids: asStringArray(row.ticket_ids),
    filtered_count: Math.max(0, Number(row.filtered_count ?? 0) || 0),
    operational_total: Math.max(0, Number(row.operational_total ?? 0) || 0),
    facets: {
      categories: asStringArray(facets.categories),
      cities: asStringArray(facets.cities),
      shirt_types: asStringArray(facets.shirt_types),
      shirt_sizes: asStringArray(facets.shirt_sizes),
    },
  };
}

export function mergeCentralFacets(
  facets: CentralListFacets,
  canonicalShirtTypes: readonly string[],
  canonicalShirtSizes: readonly string[],
): CentralListFacets {
  const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));
  return {
    categories: unique(facets.categories).sort((a, b) => a.localeCompare(b, "pt-BR")),
    cities: unique(facets.cities).sort((a, b) => a.localeCompare(b, "pt-BR")),
    shirt_types: unique([...canonicalShirtTypes, ...facets.shirt_types]),
    shirt_sizes: unique([...canonicalShirtSizes, ...facets.shirt_sizes]),
  };
}

export function windowTicketsThenFallbacks(input: {
  ticketCount: number;
  fallbackCount: number;
  page: number;
  pageSize: number;
}) {
  const start = (Math.max(1, input.page) - 1) * input.pageSize;
  const end = start + input.pageSize;
  const ticketStart = Math.min(start, input.ticketCount);
  const ticketEnd = Math.min(end, input.ticketCount);
  const fallbackStart = Math.max(0, start - input.ticketCount);
  const fallbackEnd = Math.max(0, end - input.ticketCount);
  return {
    ticketOffset: ticketStart,
    ticketLimit: Math.max(0, ticketEnd - ticketStart),
    fallbackOffset: fallbackStart,
    fallbackLimit: Math.max(0, Math.min(input.fallbackCount, fallbackEnd) - fallbackStart),
    filteredCount: input.ticketCount + input.fallbackCount,
    totalPages: Math.max(1, Math.ceil((input.ticketCount + input.fallbackCount) / input.pageSize) || 1),
  };
}

export function filterFallbackCentralRow(
  row: {
    kind?: string;
    category_name?: string | null;
    city?: string | null;
    gender?: string | null;
    birth_date?: string | null;
    payment_status?: string | null;
    kit_status?: string | null;
    checkin_status?: string | null;
    wristband_status?: string | null;
    shirt_type?: string | null;
    shirt_size?: string | null;
    ticket_display_code?: string | null;
    participant_name?: string | null;
    participant_email?: string | null;
    cpf?: string | null;
    phone?: string | null;
    buyer_name?: string | null;
    buyer_cpf?: string | null;
    buyer_phone?: string | null;
    buyer_email?: string | null;
    order_number?: string | null;
    wristband_code?: string | null;
    payment_kind?: string | null;
    event_has_kit?: boolean;
    event_wristband_enabled?: boolean;
  },
  filters: CentralListFilters,
) {
  const search = (filters.search ?? "").trim();
  if (search) {
    const matched = matchesTicketCentralSearch(search, row, [
      row.participant_name,
      row.participant_email,
      row.cpf,
      row.phone,
      row.buyer_name,
      row.buyer_cpf,
      row.buyer_phone,
      row.buyer_email,
      row.order_number,
      row.ticket_display_code,
      row.wristband_code,
    ]);
    if (!matched) return false;
  }
  if (filters.category && filters.category !== "all" && row.category_name !== filters.category) return false;
  if (filters.city && filters.city !== "all" && row.city !== filters.city) return false;
  if (filters.gender === "not_informed" && row.gender) return false;
  if (filters.gender && filters.gender !== "all" && filters.gender !== "not_informed" && row.gender !== filters.gender) {
    return false;
  }
  if (!inCentralAgeGroup(getCentralAge(row.birth_date), filters.ageGroup)) return false;
  if (filters.paymentStatus && filters.paymentStatus !== "all" && row.payment_status !== filters.paymentStatus) {
    return false;
  }
  if (filters.kitStatus && filters.kitStatus !== "all" && row.kit_status !== filters.kitStatus) return false;
  if (filters.checkinStatus && filters.checkinStatus !== "all" && row.checkin_status !== filters.checkinStatus) {
    return false;
  }
  if (filters.wristbandStatus === "active" && row.wristband_status !== "active") return false;
  if (filters.wristbandStatus === "pending" && row.wristband_status === "active") return false;
  if (filters.shirtType && filters.shirtType !== "all" && row.shirt_type !== filters.shirtType) return false;
  if (filters.shirtSize && filters.shirtSize !== "all" && row.shirt_size !== filters.shirtSize) return false;
  if (filters.onlyPending && !isCentralTicketPending({
    kind: row.kind ?? "participant_without_ticket",
    payment_kind: row.payment_kind,
    checkin_status: row.checkin_status,
    event_has_kit: row.event_has_kit,
    kit_status: row.kit_status,
    event_wristband_enabled: row.event_wristband_enabled,
    wristband_status: row.wristband_status,
  })) {
    return false;
  }
  return true;
}
