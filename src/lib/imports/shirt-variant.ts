/**
 * Resolucao Tipo + Tamanho -> event_kit_item_variants.id.
 * Mesma regra de ensure_ticket_kit_items: name case-insensitive, size uppercase.
 * 0 ou >1 matches nunca escolhem silenciosamente.
 */

export type ShirtVariantCandidate = {
  id: string;
  name: string | null | undefined;
  value: string | null | undefined;
  is_active?: boolean | null;
};

export type ShirtVariantResolution =
  | { status: 'unspecified'; variantId: null; matchCount: 0 }
  | { status: 'resolved'; variantId: string; matchCount: 1 }
  | { status: 'missing'; variantId: null; matchCount: 0 }
  | { status: 'ambiguous'; variantId: null; matchCount: number };

export function shirtVariantMatchKey(name: string | null | undefined, value: string | null | undefined) {
  return `${String(name ?? '').trim().toLowerCase()}::${String(value ?? '').trim().toUpperCase()}`;
}

export function resolveShirtVariant(
  variants: ShirtVariantCandidate[],
  shirtType: string | null | undefined,
  shirtSize: string | null | undefined,
): ShirtVariantResolution {
  const type = String(shirtType ?? '').trim();
  const size = String(shirtSize ?? '').trim();
  if (!type || !size) return { status: 'unspecified', variantId: null, matchCount: 0 };

  const wanted = shirtVariantMatchKey(type, size);
  const matches = variants.filter((variant) =>
    variant.is_active !== false
    && Boolean(variant.id)
    && shirtVariantMatchKey(variant.name, variant.value) === wanted
  );
  if (matches.length === 1) return { status: 'resolved', variantId: String(matches[0].id), matchCount: 1 };
  if (matches.length === 0) return { status: 'missing', variantId: null, matchCount: 0 };
  return { status: 'ambiguous', variantId: null, matchCount: matches.length };
}

export function shirtVariantReviewIssue(resolution: ShirtVariantResolution, shirtType: string, shirtSize: string) {
  if (resolution.status === 'missing') {
    return {
      field_code: 'shirt_selection',
      issue_type: 'invalid_variant',
      message: `Camiseta "${shirtType} ${shirtSize}" nao corresponde a nenhuma variante ativa do evento.`,
      blocks_payment: false,
      blocks_ticket_issuance: false,
      blocks_checkin: false,
      blocks_kit_delivery: true,
    };
  }
  if (resolution.status === 'ambiguous') {
    return {
      field_code: 'shirt_selection',
      issue_type: 'ambiguous_variant',
      message: `Camiseta "${shirtType} ${shirtSize}" corresponde a ${resolution.matchCount} variantes ativas. Nao foi escolhida automaticamente.`,
      blocks_payment: false,
      blocks_ticket_issuance: false,
      blocks_checkin: false,
      blocks_kit_delivery: true,
    };
  }
  return null;
}
