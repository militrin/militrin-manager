import { createServerSupabaseClient } from '@/lib/supabase/server';

export type EventCapabilities = {
  /** null = nenhum evento ativo encontrado */
  eventId: string | null;
  organizationId: string | null;
  /** Existe ao menos um evento administrativo não arquivado na organização. */
  hasEvents: boolean;
  /** registration_enabled diretamente do evento */
  registrationEnabled: boolean;
  /** Possui vendas configuradas (= registrationEnabled) */
  hasOrders: boolean;
  /** Possui fluxo financeiro (= registrationEnabled) */
  hasFinance: boolean;
  /** Check-in sempre disponível quando há evento */
  hasCheckin: boolean;
  /** kit_enabled OU existe ao menos 1 event_kit_item ativo */
  hasDistributableItems: boolean;
  /** Existe ao menos 1 linha de shirt_inventory para o evento */
  hasInventory: boolean;
  /** Existe ao menos 1 compromisso ativo no cronograma do evento */
  hasDeliverySchedule: boolean;
  /** wristband_enabled diretamente do evento */
  hasWristbands: boolean;
  /** Fotos não têm flag — sempre disponível quando há evento */
  hasPhotos: boolean;
};

const empty: EventCapabilities = {
  eventId: null,
  organizationId: null,
  hasEvents: false,
  registrationEnabled: false,
  hasOrders: false,
  hasFinance: false,
  hasCheckin: false,
  hasDistributableItems: false,
  hasInventory: false,
  hasDeliverySchedule: false,
  hasWristbands: false,
  hasPhotos: false,
};

/**
 * Resolve as capacidades do evento ativo da organização do usuário autenticado.
 * Nunca confia em event_id vindo do cliente.
 */
export async function getOrganizationEventCapabilities(): Promise<EventCapabilities> {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return empty;

  // Localiza a organização ativa do usuário (primeira organização membro)
  const { data: member } = await supabase
    .from('organization_members')
    .select('organization_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .order('joined_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  // Platform owner sem org membership: busca qualquer org ativa
  let orgId: string | null = member?.organization_id ?? null;

  if (!orgId) {
    const { data: platformUser } = await supabase
      .from('platform_users')
      .select('user_id, role')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle();

    if (platformUser?.role === 'owner' || platformUser?.role === 'admin') {
      const { data: firstOrg } = await supabase
        .from('organizations')
        .select('id')
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      orgId = firstOrg?.id ?? null;
    }
  }

  if (!orgId) return empty;

  // Localiza o evento ativo da organização
  const { data: events } = await supabase
    .from('events')
    .select('id, organization_id, registration_enabled, kit_enabled, wristband_enabled')
    .eq('organization_id', orgId)
    .is('archived_at', null);

  if (!events?.length) return { ...empty, organizationId: orgId };

  const eventIds = events.map((event) => String(event.id));
  const registrationEnabled = events.some((event) => Boolean(event.registration_enabled));
  const kitEnabled = events.some((event) => Boolean(event.kit_enabled));
  const wristbandEnabled = events.some((event) => Boolean(event.wristband_enabled));

  // Verifica existência de kit items ativos
  const { count: kitItemsCount } = await supabase
    .from('event_kit_items')
    .select('id', { count: 'exact', head: true })
    .in('event_id', eventIds)
    .eq('is_active', true);

  // Verifica existência de shirt_inventory para o evento
  const { count: inventoryCount } = await supabase
    .from('shirt_inventory')
    .select('id', { count: 'exact', head: true })
    .in('event_id', eventIds);

  const hasDistributableItems = kitEnabled || (kitItemsCount ?? 0) > 0;
  const hasInventory = (inventoryCount ?? 0) > 0;

  const { count: scheduleCount } = await supabase
    .from('kit_delivery_schedule')
    .select('id', { count: 'exact', head: true })
    .in('event_id', eventIds)
    .eq('is_active', true);
  const hasDeliverySchedule = (scheduleCount ?? 0) > 0;

  return {
    eventId: null,
    organizationId: orgId,
    hasEvents: true,
    registrationEnabled,
    hasOrders: registrationEnabled,
    hasFinance: registrationEnabled,
    hasCheckin: true, // check-in sempre disponível quando há evento
    hasDistributableItems,
    hasInventory,
    hasDeliverySchedule,
    hasWristbands: wristbandEnabled,
    hasPhotos: true, // fotos não têm flag de evento
  };
}
