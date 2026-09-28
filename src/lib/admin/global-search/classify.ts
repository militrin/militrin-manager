import {
  parsePublicOrderQuery,
  parseStoredMilOrderNumber,
  parseTicketDisplayCode,
} from "../../display-reference.ts";
import { isValidCpf, normalizeCpfDigits } from "../../imports/import-row-validation.ts";
import { normalizeEmail, normalizeForMatch, normalizePhone } from "../../imports/normalization.ts";
import { isUuidLike } from "../operator-display.ts";
import { parseTokenCandidate } from "../../tickets/parse-token-candidate.ts";
import { GLOBAL_SEARCH_NAME_MIN_CHARS } from "./constants.ts";
import type { ClassifiedAdminQuery, GlobalSearchKind } from "./types.ts";

function emptyClassification(raw: string, trimmed: string, token: string, kind: GlobalSearchKind, minChars = GLOBAL_SEARCH_NAME_MIN_CHARS): ClassifiedAdminQuery {
  return {
    raw,
    trimmed,
    token,
    kind,
    searchText: token || trimmed,
    minChars,
    email: null,
    cpfDigits: null,
    phoneDigits: null,
    orderQuery: null,
    ticketCode: null,
    uuid: null,
    wristbandCode: null,
    nameNeedle: null,
  };
}

function looksLikeUrl(value: string) {
  return /^https?:\/\//i.test(value.trim()) || /^[a-z]+:\/\//i.test(value.trim());
}

function compactIdentifier(value: string) {
  return value.replace(/\s+/g, "");
}

function isLikelyWristbandCode(value: string) {
  const compact = compactIdentifier(value);
  if (compact.length < 12) return false;
  if (!/^[0-9A-Za-z._-]+$/.test(compact)) return false;
  const digits = compact.replace(/\D/g, "");
  if (digits.length >= 16) return true;
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) return false;
  if (digits.length === 11 && isValidCpf(digits)) return false;
  return digits.length >= 12 || compact.length >= 16;
}

function isLikelyPhoneDigits(digits: string) {
  if (digits.length === 10 || digits.length === 11) return !isValidCpf(digits);
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) return true;
  return false;
}

function hasLetter(value: string) {
  return /[A-Za-zÀ-ÿ]/.test(value);
}

export function classifyAdminSearchQuery(raw: unknown): ClassifiedAdminQuery {
  const original = String(raw ?? "");
  const trimmed = original.trim();
  const token = parseTokenCandidate(trimmed);
  const source = token || trimmed;

  if (!trimmed) return emptyClassification(original, trimmed, token, "empty");

  const email = normalizeEmail(source) ?? normalizeEmail(trimmed);
  if (email) {
    return { ...emptyClassification(original, trimmed, source, "email"), email, searchText: email };
  }

  const ticketCode = parseTicketDisplayCode(source) ?? parseTicketDisplayCode(trimmed);
  if (ticketCode) {
    return { ...emptyClassification(original, trimmed, source, "ticket"), ticketCode, searchText: source };
  }

  const mil = parseStoredMilOrderNumber(source) ?? parseStoredMilOrderNumber(trimmed);
  if (mil) {
    return {
      ...emptyClassification(original, trimmed, source, "order"),
      orderQuery: { kind: "mil", canonical: mil.canonical, year: mil.year, sequence: mil.sequence },
      searchText: source,
    };
  }

  const orderQuery = parsePublicOrderQuery(source) ?? parsePublicOrderQuery(trimmed);

  if (isUuidLike(source) || isUuidLike(trimmed)) {
    const uuid = source;
    return { ...emptyClassification(original, trimmed, source, "uuid"), uuid, searchText: uuid };
  }

  if (looksLikeUrl(trimmed) || looksLikeUrl(source)) {
    return { ...emptyClassification(original, trimmed, source, "token"), searchText: source };
  }

  const compact = compactIdentifier(source);
  const digits = normalizeCpfDigits(compact);

  if (isLikelyWristbandCode(source) || isLikelyWristbandCode(trimmed)) {
    return {
      ...emptyClassification(original, trimmed, source, "wristband"),
      wristbandCode: compact,
      searchText: compact,
    };
  }

  if (digits.length === 11 && isValidCpf(digits) && compact.replace(/\D/g, "").length === 11 && compact.length <= 14) {
    return { ...emptyClassification(original, trimmed, source, "cpf"), cpfDigits: digits, searchText: digits };
  }

  const phoneDigits = normalizePhone(source) ?? normalizePhone(trimmed);
  if (phoneDigits && isLikelyPhoneDigits(phoneDigits) && !hasLetter(compact)) {
    return { ...emptyClassification(original, trimmed, source, "phone"), phoneDigits, searchText: phoneDigits };
  }

  if (orderQuery && !hasLetter(compact.replace(/^pedido:?/i, ""))) {
    return { ...emptyClassification(original, trimmed, source, "order"), orderQuery, searchText: source };
  }

  if (source.length >= 20 && !/\s/.test(source) && /[0-9A-Za-z]/.test(source)) {
    return { ...emptyClassification(original, trimmed, source, "token"), searchText: source };
  }

  if (hasLetter(trimmed)) {
    if (normalizeForMatch(trimmed).length < GLOBAL_SEARCH_NAME_MIN_CHARS) {
      return emptyClassification(original, trimmed, source, "too_short");
    }
    return {
      ...emptyClassification(original, trimmed, source, "name"),
      nameNeedle: normalizeForMatch(trimmed),
      searchText: trimmed,
    };
  }

  if (orderQuery) {
    return { ...emptyClassification(original, trimmed, source, "order"), orderQuery, searchText: source };
  }

  if (trimmed.length < GLOBAL_SEARCH_NAME_MIN_CHARS) {
    return emptyClassification(original, trimmed, source, "too_short");
  }

  return emptyClassification(original, trimmed, source, "too_short");
}

export function escapeIlikePattern(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function nameMatchesQuery(fullName: string | null | undefined, query: string) {
  const needle = normalizeForMatch(query);
  if (!needle) return false;
  return normalizeForMatch(String(fullName ?? "")).includes(needle);
}

export function personSearchKinds(kind: GlobalSearchKind) {
  return kind === "name" || kind === "cpf" || kind === "email" || kind === "phone" || kind === "uuid";
}

export function ticketSearchKinds(kind: GlobalSearchKind) {
  return kind === "ticket" || kind === "token" || kind === "uuid" || kind === "name" || kind === "email" || kind === "cpf" || kind === "phone";
}

/**
 * Números — comportamento previsível (não é um parser perfeito):
 * - 1–8 dígitos, opcional `#`/`pedido:` → pedido (display_number exato).
 * - `MIL-YYYY-…` → pedido.
 * - `NNNN-NN` / `#001687-01` → ingresso, nunca pedido.
 * - 11 dígitos com CPF válido → CPF, nunca telefone/pedido.
 * - 10–11 dígitos que não são CPF, ou 12–13 começando com 55 → telefone.
 * - 16+ dígitos (código de pulseira) → pulseira, nunca telefone/nome.
 * A classificação vale para a entrada INTEIRA. "1966" no meio de um
 * telefone colado como 11 dígitos não vira pedido.
 */
export function globalSearchPlan(kind: GlobalSearchKind, permissions: { participantsView: boolean; ordersView: boolean; wristbandsView: boolean }) {
  const canReadTickets = permissions.participantsView || permissions.ordersView;
  const relatedOrdersFromPeople = permissions.ordersView && permissions.participantsView && personSearchKinds(kind);
  return {
    people: permissions.participantsView && personSearchKinds(kind),
    orders: permissions.ordersView && (kind === "order" || kind === "uuid" || relatedOrdersFromPeople),
    tickets: canReadTickets && ticketSearchKinds(kind),
    wristbands: permissions.wristbandsView && (kind === "wristband" || ticketSearchKinds(kind)),
  };
}

export function phoneDigitsMatch(stored: string | null | undefined, queryDigits: string) {
  const storedDigits = String(stored ?? "").replace(/\D/g, "");
  if (!storedDigits || !queryDigits) return false;
  if (storedDigits === queryDigits) return true;
  const a = storedDigits.startsWith("55") ? storedDigits.slice(2) : storedDigits;
  const b = queryDigits.startsWith("55") ? queryDigits.slice(2) : queryDigits;
  return a === b || storedDigits.endsWith(b) || queryDigits.endsWith(a);
}
