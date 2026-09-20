const GENDER_COPY: Record<string, string> = {
  male: "Masculino",
  masculino: "Masculino",
  female: "Feminino",
  feminino: "Feminino",
  other: "Outro",
  outro: "Outro",
  prefer_not_to_say: "Prefiro não informar",
};

function normalizeTariffGender(value: string | null | undefined) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "male" || raw === "masculino" || raw === "m") return "male";
  if (raw === "female" || raw === "feminino" || raw === "f") return "female";
  return null;
}

export type TurboOperationalGenderValue = "male" | "female" | null;
export type TurboOperationalGenderSource = "pricing" | "legacy_profile" | "unknown";

/** Apresentação operacional. Nunca persistir source/value de volta em order_items. */
export type TurboOperationalGender = {
  value: TurboOperationalGenderValue;
  source: TurboOperationalGenderSource;
};

export function turboGenderLabel(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "null" || raw.toLowerCase() === "undefined") return "Não informado";
  const mapped = GENDER_COPY[raw.toLowerCase().replace(/\s+/g, "_")];
  if (mapped) return mapped;
  if (/^[a-z][a-z0-9_]*$/.test(raw)) return "Não informado";
  return raw;
}

export function turboOperationalGenderLabel(value: string | null | undefined) {
  const normalized = normalizeTariffGender(value);
  if (normalized === "male") return "Masculino";
  if (normalized === "female") return "Feminino";
  return "Não definido";
}

export function turboOperationalGenderDisplay(resolved: TurboOperationalGender) {
  return turboOperationalGenderLabel(resolved.value);
}

/**
 * Ingresso legado da importação oficial. Não usar buyer_type remapeado por
 * histórico de participante: um checkout novo da mesma pessoa continua moderno.
 */
export function isLegacyImportedTicket(input: {
  import_batch_id?: string | null;
  order_buyer_type?: string | null;
}) {
  return Boolean(input.import_batch_id) || input.order_buyer_type === "imported_holder";
}

/**
 * Gênero da ficha Turbo.
 * 1) pricing_gender male/female sempre vence.
 * 2) Só se pricing_gender for null E o ingresso for importado/legado:
 *    fallback visual de participant.gender / contact.gender.
 * 3) Se participant e contact divergirem, ou se for ingresso moderno sem
 *    pricing_gender: Não definido. Nunca grava no banco.
 */
export function resolveTurboOperationalGender(input: {
  pricing_gender?: string | null;
  participant_gender?: string | null;
  contact_gender?: string | null;
  import_batch_id?: string | null;
  order_buyer_type?: string | null;
  isLegacyImported?: boolean;
}): TurboOperationalGender {
  const pricing = normalizeTariffGender(input.pricing_gender);
  if (pricing) return { value: pricing, source: "pricing" };

  const legacy = input.isLegacyImported ?? isLegacyImportedTicket(input);
  if (!legacy) return { value: null, source: "unknown" };

  const participant = normalizeTariffGender(input.participant_gender);
  const contact = normalizeTariffGender(input.contact_gender);
  if (participant && contact && participant !== contact) {
    return { value: null, source: "unknown" };
  }

  const fallback = participant ?? contact;
  if (fallback) return { value: fallback, source: "legacy_profile" };
  return { value: null, source: "unknown" };
}

export function turboGenderFromTicket(ticket: {
  pricing_gender?: string | null;
  gender?: string | null;
  contact_gender?: string | null;
  import_batch_id?: string | null;
  order_buyer_type?: string | null;
  isLegacyImported?: boolean;
  turbo_gender?: TurboOperationalGender;
}) {
  const resolved = ticket.turbo_gender ?? resolveTurboOperationalGender({
    pricing_gender: ticket.pricing_gender,
    participant_gender: ticket.gender,
    contact_gender: ticket.contact_gender,
    import_batch_id: ticket.import_batch_id,
    order_buyer_type: ticket.order_buyer_type,
    isLegacyImported: ticket.isLegacyImported,
  });
  return turboOperationalGenderDisplay(resolved);
}
