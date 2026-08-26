import type { SupabaseClient } from '@supabase/supabase-js';
import { formatDateLongBR } from '@/lib/utils/date';
import type { MilitrinHeaderEvent } from '@/components/militrin/MilitrinHeader';

const WEEKDAY_LABELS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function formatHour(date: Date) {
  return date.getMinutes() ? `${pad(date.getHours())}h${pad(date.getMinutes())}` : `${pad(date.getHours())}h`;
}

function formatEventSchedule(startsAt: string | null | undefined, endsAt: string | null | undefined): string | null {
  if (!startsAt) return null;
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return null;

  const weekday = WEEKDAY_LABELS[start.getDay()];
  const end = endsAt ? new Date(endsAt) : null;
  const endValid = end && !Number.isNaN(end.getTime());
  return endValid ? `${weekday} • ${formatHour(start)} às ${formatHour(end)}` : `${weekday} • ${formatHour(start)}`;
}

type EventRow = {
  name: string | null;
  starts_at: string | null;
  ends_at?: string | null;
  location: string | null;
};

/**
 * Monta o shape esperado por <MilitrinHeader event={...} /> a partir de uma
 * linha de `events` -- fonte unica pra nao divergir formatacao entre a
 * listagem (evento "em destaque" da conta) e o detalhe do ingresso (evento
 * do proprio ingresso).
 */
export function buildAccountHeaderEvent(event: EventRow): MilitrinHeaderEvent {
  return {
    name: event.name ?? 'Evento',
    date: event.starts_at ? formatDateLongBR(event.starts_at) : 'Data a confirmar',
    schedule: formatEventSchedule(event.starts_at, event.ends_at),
    location: event.location ?? 'Local a confirmar',
  };
}

/**
 * Evento "em destaque" pra header global de paginas que listam varios
 * pedidos/ingressos (podem cobrir eventos diferentes): o proximo evento com
 * inscricoes habilitadas. Retorna null quando nao ha nenhum -- quem chama
 * decide o fallback (ex.: nao renderizar o header).
 */
export async function getPrimaryAccountHeaderEvent(supabase: SupabaseClient): Promise<MilitrinHeaderEvent | null> {
  const { data } = await supabase
    .from('events')
    .select('name, starts_at, ends_at, location')
    .eq('registration_enabled', true)
    .order('starts_at', { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return buildAccountHeaderEvent(data as EventRow);
}
