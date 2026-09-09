import { resolveShirtVariant, type ShirtVariantCandidate } from '@/lib/imports/shirt-variant';

export type MissingShirtLink = {
  linkId: string;
  ticketId: string | null;
  orderItemId: string | null;
  kitItemId: string;
  shirtType: string | null;
  shirtSize: string | null;
  currentVariantId: string | null;
  inventoryReservationAccounted?: boolean | null;
};

export type ShirtVariantRepairDecision =
  | { status: 'resolved'; variantId: string }
  | { status: 'missing' }
  | { status: 'ambiguous'; matchCount: number }
  | { status: 'already_linked' }
  | { status: 'unspecified' };

export function classifyShirtVariantRepair(
  link: MissingShirtLink,
  catalog: ShirtVariantCandidate[],
): ShirtVariantRepairDecision {
  if (String(link.currentVariantId ?? '').trim()) return { status: 'already_linked' };
  const resolution = resolveShirtVariant(catalog, link.shirtType, link.shirtSize);
  if (resolution.status === 'resolved') return { status: 'resolved', variantId: resolution.variantId };
  if (resolution.status === 'ambiguous') return { status: 'ambiguous', matchCount: resolution.matchCount };
  if (resolution.status === 'unspecified') return { status: 'unspecified' };
  return { status: 'missing' };
}

export function planShirtVariantRepairs(links: MissingShirtLink[], catalog: ShirtVariantCandidate[]) {
  const decisions = links.map((link) => ({ link, decision: classifyShirtVariantRepair(link, catalog) }));
  return {
    resolvable: decisions.filter((row) => row.decision.status === 'resolved'),
    missing: decisions.filter((row) => row.decision.status === 'missing'),
    ambiguous: decisions.filter((row) => row.decision.status === 'ambiguous'),
    unspecified: decisions.filter((row) => row.decision.status === 'unspecified'),
    alreadyLinked: decisions.filter((row) => row.decision.status === 'already_linked'),
  };
}
