import type { SupabaseClient } from '@supabase/supabase-js';
import { formatDateLongBR, dateTimePartsInEventTimeZone, EVENT_TIMEZONE } from '@/lib/utils/date';
import type { MilitrinHeaderEvent } from '@/components/militrin/MilitrinHeader';
import {
  isAccountHeaderEventEligible,
  resolveAccountHeaderCta,
  type AccountHeaderEventRow,
} from './account-header-rules';

export {
  isAccountHeaderEventEligible,
  resolveAccountHeaderCta,
  type AccountHeaderEventRow,
} from './account-header-rules';

function formatHourParts(hour: string, minute: string) {
  return Number(minute) ? `${hour}h${minute}` : `${hour}h`;
}

export function formatEventSchedule(startsAt: string | null | undefined, endsAt: string | null | undefined): string | null {
  if (!startsAt) return null;
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return null;

  const weekday = new Intl.DateTimeFormat('pt-BR', {
    timeZone: EVENT_TIMEZONE,
    weekday: 'long',
  }).format(start);
  const weekdayLabel = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  const startParts = dateTimePartsInEventTimeZone(start);
  const end = endsAt ? new Date(endsAt) : null;
  const endValid = end && !Number.isNaN(end.getTime());
  if (!endValid) return `${weekdayLabel} • ${formatHourParts(startParts.hour, startParts.minute)}`;
  const endParts = dateTimePartsInEventTimeZone(end);
  return `${weekdayLabel} • ${formatHourParts(startParts.hour, startParts.minute)} às ${formatHourParts(endParts.hour, endParts.minute)}`;
}

/**
 * Monta o shape esperado por <MilitrinHeader event={...} /> a partir de uma
 * linha de `events` -- fonte unica pra nao divergir formatacao entre a
 * listagem (evento "em destaque" da conta) e o detalhe do ingresso (evento
 * do proprio ingresso).
 */
export function buildAccountHeaderEvent(event: AccountHeaderEventRow): MilitrinHeaderEvent {
  const cta = resolveAccountHeaderCta(event);
  return {
    name: event.name ?? 'Evento',
    year: event.year ?? null,
    imageUrl: event.banner_card_url || event.banner_hero_url || null,
    date: event.starts_at ? formatDateLongBR(event.starts_at) : 'Data a confirmar',
    schedule: formatEventSchedule(event.starts_at, event.ends_at),
    location: event.location ?? 'Local a confirmar',
    showBuyButton: cta.showBuyButton,
    buyHref: cta.buyHref,
  };
}

/**
 * Evento em destaque da Minha Conta: o unico evento da organizacao marcado
 * em events.featured_on_account, e so se ainda estiver ativo/elegivel.
 * Sem elegivel, o cabecalho nao renderiza -- nunca fallback para um evento
 * hardcoded ou para o proximo com inscricao aberta.
 */
export async function getPrimaryAccountHeaderEvent(supabase: SupabaseClient): Promise<MilitrinHeaderEvent | null> {
  const { data } = await supabase
    .from('events')
    .select('name, slug, year, starts_at, ends_at, location, banner_card_url, banner_hero_url, is_active, archived_at, featured_on_account, registration_enabled, registration_open_at, registration_close_at')
    .eq('featured_on_account', true)
    .order('starts_at', { ascending: true, nullsFirst: false });

  const now = new Date();
  const eligible = ((data ?? []) as AccountHeaderEventRow[]).find((event) => isAccountHeaderEventEligible(event, now));
  if (!eligible) return null;
  return buildAccountHeaderEvent(eligible);
}
