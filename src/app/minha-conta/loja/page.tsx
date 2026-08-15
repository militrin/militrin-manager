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

  if (events.length === 0) {
    return (
      <MilitrinSection eyebrow="Loja" title="Loja" description="Itens opcionais do seu evento">
        <MilitrinEmptyState title="Nenhum evento disponível" description="A loja fica disponível assim que você tiver um ingresso de um evento." />
      </MilitrinSection>
    );
  }

  const items = selectedEventId
    ? await getStoreItemsForEvent(supabase, selectedEventId)
    : await getStoreItemsForEvents(supabase, events.map((event) => event.id));
  const selectedEventName = selectedEventId ? events.find((event) => event.id === selectedEventId)?.name ?? 'Evento' : 'Todos os eventos';

  const ordersQuery = supabase
    .from('store_orders')
    .select('id, order_number, status, payment_method, payment_status, final_amount, pix_code, pix_qrcode, expires_at, created_at, store_order_items(id, quantity, final_amount, status, store_items(name), store_item_variants(name, value))')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  const { data: myOrders } = selectedEventId
    ? await ordersQuery.eq('event_id', selectedEventId)
    : await ordersQuery.in('event_id', events.map((event) => event.id));

  return (
    <div className="space-y-5">
      <MilitrinSection
        eyebrow="Loja"
        title="Loja"
        description="Itens opcionais que você pode comprar avulso, além do ingresso."
        action={
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
        }
      >
        {items.length === 0 ? (
          <MilitrinEmptyState title="Nenhum item disponível" description="Ainda não há itens opcionais cadastrados." />
        ) : (
          <AccountStoreShop events={selectedEventId ? [{ id: selectedEventId, name: selectedEventName }] : events} items={items} />
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
