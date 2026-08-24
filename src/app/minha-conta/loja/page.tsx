import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAccountOrders, getAccessibleTicketScope } from '@/lib/account/portal-orders-and-tickets';
import { getStoreItemsForEvent, getStoreItemsForEvents } from '@/lib/store/get-store-items';
import { MilitrinEmptyState, MilitrinSection } from '@/components/militrin';
import { AccountStoreShop } from '@/components/store/AccountStoreShop';
import { AccountStoreOrders } from './account-store-orders';

async function getEventOptions(userId: string) {
  const supabase = await createServerSupabaseClient();
  const ordersResult = await getAccountOrders(supabase, userId);
  const orders = (ordersResult.data ?? []) as Array<Record<string, unknown>>;
  const scope = await getAccessibleTicketScope(supabase, userId, orders);
  const eventIds = scope.ownedEventIds;
  if (eventIds.length === 0) return [] as Array<{ id: string; name: string }>;

  const { data: events } = await supabase.from('events').select('id, name').in('id', eventIds);
  return (events ?? []).map((event) => ({ id: String(event.id), name: String(event.name) }));
}

export default async function AccountStorePage({ searchParams }: { searchParams: Promise<{ eventId?: string }> }) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const params = await searchParams;
  const events = await getEventOptions(user.id);
  const selectedEventId = params.eventId && events.some((event) => event.id === params.eventId) ? params.eventId : null;

  // visibleProducts = globalProducts UNION accessibleEventProducts. Produto
  // global (Todos os eventos) nunca depende de o usuario ter ingresso --
  // carregado sempre, incondicionalmente. Produtos de evento so entram
  // quando ha evento acessivel/selecionado.
  const globalItems = await getStoreItemsForEvent(supabase, null);
  const eventItems = events.length === 0
    ? []
    : selectedEventId
      ? await getStoreItemsForEvent(supabase, selectedEventId)
      : await getStoreItemsForEvents(supabase, events.map((event) => event.id));
  // getStoreItemsForEvent/getStoreItemsForEvents ja incluem os globais em
  // cada chamada por evento (a RPC list_store_items_for_event retorna
  // `event_id = p_event_id or event_id is null`) -- filtra pra nao duplicar
  // com globalItems na secao "Produtos para todos".
  const eventOnlyItems = eventItems.filter((item) => item.eventId !== null);
  const selectedEventName = selectedEventId ? events.find((event) => event.id === selectedEventId)?.name ?? 'Evento' : 'Todos os eventos';
  const hasAnyItem = globalItems.length > 0 || eventOnlyItems.length > 0;

  const ordersQuery = supabase
    .from('store_orders')
    .select('id, order_number, display_number, status, payment_method, payment_status, final_amount, pix_code, pix_qrcode, expires_at, created_at, store_order_items(id, quantity, final_amount, status, store_items(name), store_item_variants(name, value))')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  const { data: myOrders } = selectedEventId
    ? await ordersQuery.eq('event_id', selectedEventId)
    : events.length > 0
      ? await ordersQuery.or(`event_id.is.null,event_id.in.(${events.map((event) => event.id).join(',')})`)
      : await ordersQuery.is('event_id', null);

  return (
    <div className="space-y-5">
      <MilitrinSection
        eyebrow="Loja"
        title="Loja"
        description="Itens opcionais que você pode comprar avulso, além do ingresso."
        action={
          events.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              <Link
                href="/minha-conta/loja"
                className={`rounded-xl border px-3 py-1.5 text-xs ${!selectedEventId ? 'border-(--brand-400)/50 bg-(--brand-500)/15 text-(--brand-100)' : 'border-slate-700 text-slate-300'}`}
              >
                Todos os itens
              </Link>
              {events.map((event) => (
                <Link
                  key={event.id}
                  href={`/minha-conta/loja?eventId=${event.id}`}
                  className={`rounded-xl border px-3 py-1.5 text-xs ${event.id === selectedEventId ? 'border-(--brand-400)/50 bg-(--brand-500)/15 text-(--brand-100)' : 'border-slate-700 text-slate-300'}`}
                >
                  {event.name}
                </Link>
              ))}
            </div>
          ) : null
        }
      >
        {!hasAnyItem ? (
          <MilitrinEmptyState title="Nenhum item disponível" description="Ainda não há itens opcionais cadastrados." />
        ) : (
          <div className="space-y-6">
            {globalItems.length > 0 ? (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-white">Produtos para todos</h3>
                <AccountStoreShop events={events} items={globalItems} />
              </div>
            ) : null}

            {events.length > 0 && eventOnlyItems.length > 0 ? (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-white">Produtos dos seus eventos</h3>
                <AccountStoreShop events={selectedEventId ? [{ id: selectedEventId, name: selectedEventName }] : events} items={eventOnlyItems} />
              </div>
            ) : null}
          </div>
        )}
      </MilitrinSection>

      {(myOrders ?? []).length > 0 ? (
        <MilitrinSection eyebrow="Histórico" title="Meus pedidos da loja">
          <AccountStoreOrders orders={(myOrders ?? []) as unknown as Parameters<typeof AccountStoreOrders>[0]['orders']} />
        </MilitrinSection>
      ) : null}
    </div>
  );
}
