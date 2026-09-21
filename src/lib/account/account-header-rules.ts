export type AccountHeaderEventRow = {
  id?: string | null;
  name?: string | null;
  slug?: string | null;
  year?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
  location?: string | null;
  banner_card_url?: string | null;
  banner_hero_url?: string | null;
  is_active?: boolean | null;
  archived_at?: string | null;
  featured_on_account?: boolean | null;
  registration_enabled?: boolean | null;
  registration_open_at?: string | null;
  registration_close_at?: string | null;
};

function isEventSaleOpen(event: AccountHeaderEventRow, now: Date = new Date()) {
  if (!event.registration_enabled) return false;
  const nowMs = now.getTime();
  const openOk = !event.registration_open_at || new Date(event.registration_open_at).getTime() <= nowMs;
  const closeOk = !event.registration_close_at || new Date(event.registration_close_at).getTime() >= nowMs;
  return openOk && closeOk;
}

export function isAccountHeaderEventEligible(event: AccountHeaderEventRow, now: Date = new Date()): boolean {
  if (!event.featured_on_account) return false;
  if (!event.is_active) return false;
  if (event.archived_at) return false;
  if (event.ends_at) {
    const endsAt = new Date(event.ends_at);
    if (!Number.isNaN(endsAt.getTime()) && endsAt.getTime() < now.getTime()) return false;
  }
  return true;
}

export function resolveAccountHeaderCta(
  event: AccountHeaderEventRow,
  now: Date = new Date(),
): { showBuyButton: boolean; buyHref: string } {
  const slug = String(event.slug ?? '').trim();
  if (!isEventSaleOpen(event, now) || !slug) {
    return { showBuyButton: false, buyHref: '/minha-conta/eventos' };
  }
  return { showBuyButton: true, buyHref: `/inscricao/${slug}` };
}
