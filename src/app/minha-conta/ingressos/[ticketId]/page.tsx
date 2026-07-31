import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateTimeBR } from '@/lib/utils/date';
import { getCurrentPermissionMap } from '@/lib/admin/permissions';
import { MilitrinButton, MilitrinSection, MilitrinStatusBadge, MilitrinTimeline, type MilitrinTimelineItem } from '@/components/militrin';
import { TicketViewer } from '@/components/public/TicketViewer';
import {
  changeTicketShirtAction,
  defineTicketHolderAction,
  transferTicketAction,
  updateTicketCategoryAction,
  updateTicketNotesAction,
} from '@/app/minha-conta/actions';
import { deliverFullKitAction, deliverKitAndCheckinAction, checkinEntryAction } from '@/app/retirada/actions';
import { SHIRT_SIZES } from '@/lib/constants/shirts';

function normalizeStatus(status: string | null | undefined) {
  const normalized = String(status ?? 'pending').toLowerCase();
  if (normalized === 'paid') return 'confirmed';
  return normalized;
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return (value[0] ?? null) as T | null;
  return (value ?? null) as T | null;
}

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export default async function TicketDetailPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  if (!isUuid(ticketId)) notFound();

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const permissions = await getCurrentPermissionMap([
    'participants.edit_basic',
    'inventory.change_participant_shirt',
    'kits.deliver',
    'checkin.scan',
    'orders.resend_ticket',
  ]);
  const canAdminEdit = Boolean(permissions['participants.edit_basic']);
  const canManageOperationalFlow = Boolean(permissions['kits.deliver'] || permissions['checkin.scan']);

  const ticketSelect =
    'id, token, status, issued_at, used_at, ownership_status, participant_id, order_id, order_item_id, orders!inner(id, order_number, status, user_id, event_id, created_at, confirmed_at, base_amount, discount_amount, final_amount, events(id, name, location, starts_at, shirt_order_deadline), payments(id, payment_method, payment_status, paid_at, final_amount)), order_items(id, item_position, status, ownership_status, holder_full_name, shirt_type, shirt_size, ticket_category_id, participant_id, notes, participants(id, full_name, email, user_id, shirt_type, shirt_size, ticket_category_id, notes, ticket_categories(name)), ticket_categories(name)), participants(id, full_name, email, user_id, shirt_type, shirt_size, ticket_category_id, notes, ticket_categories(name))';

  const ownedTicketQuery = await supabase
    .from('tickets')
    .select(ticketSelect)
    .eq('id', ticketId)
    .eq('orders.user_id', user?.id ?? '')
    .maybeSingle();

  const adminTicketQuery = canAdminEdit && !ownedTicketQuery.data
    ? await supabase
        .from('tickets')
        .select(ticketSelect)
        .eq('id', ticketId)
        .maybeSingle()
    : null;

  const ticketResult = ownedTicketQuery.data ? ownedTicketQuery : adminTicketQuery ?? ownedTicketQuery;
  const ticketError = ticketResult.error;
  const ticket = ticketResult.data as Record<string, unknown> | null;
  const resolvedTicketId = String(ticket?.id ?? ticketId);

  if (ticketError) {
    console.error('[minha-conta/ingressos/[ticketId]] erro ao carregar ticket', { ticketId, ticketError });
    return (
      <section className="rounded-2xl border border-rose-700/40 bg-rose-950/20 p-4 text-sm text-rose-100">
        Nao foi possivel carregar os detalhes deste ingresso agora.
      </section>
    );
  }
  if (!ticket) notFound();

  const order = firstRelation(ticket.orders as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
  const orderItem = firstRelation(ticket.order_items as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
  const participant = firstRelation((orderItem?.participants as Record<string, unknown> | Record<string, unknown>[] | null | undefined) ?? (ticket.participants as Record<string, unknown> | Record<string, unknown>[] | null | undefined));
  const payment = firstRelation(order?.payments as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
  const eventObj = firstRelation(order?.events as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
  const categoryObj = firstRelation((orderItem?.ticket_categories as Record<string, unknown> | Record<string, unknown>[] | null | undefined) ?? (participant?.ticket_categories as Record<string, unknown> | Record<string, unknown>[] | null | undefined));

  const participantId = String(orderItem?.participant_id ?? ticket.participant_id ?? participant?.id ?? '');
  const orderId = String(order?.id ?? ticket.order_id ?? '');
  const orderItemId = String(orderItem?.id ?? ticket.order_item_id ?? '');
  const eventId = String(order?.event_id ?? '');
  const orderStatus = normalizeStatus(String(order?.status ?? 'pending'));
  const paymentStatus = normalizeStatus(String(payment?.payment_status ?? 'pending'));
  const ticketStatus = normalizeStatus(String(ticket.status ?? 'pending'));
  const canShowTicket = orderStatus === 'confirmed' && (ticketStatus === 'active' || ticketStatus === 'used');
  const holderName = String(participant?.full_name ?? orderItem?.holder_full_name ?? 'Titular ainda nao definido');
  const shirtType = String(orderItem?.shirt_type ?? participant?.shirt_type ?? 'Camiseta');
  const shirtSize = String(orderItem?.shirt_size ?? participant?.shirt_size ?? '');
  const shirtDeadline = eventObj?.shirt_order_deadline ? new Date(String(eventObj.shirt_order_deadline)) : null;
  const afterDeadline = shirtDeadline ? new Date().getTime() > shirtDeadline.getTime() : false;

  const [linkedParticipantsResult, inventoryResult, kitItemsResult, timelineResult, categoriesResult] = await Promise.all([
    participantId
      ? supabase
          .from('participants')
          .select('id, full_name, ticket_category_id, shirt_type, shirt_size, user_id')
          .eq('event_id', eventId)
          .eq('user_id', user?.id ?? '')
          .order('created_at', { ascending: true })
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    eventId
      ? supabase
          .from('shirt_inventory')
          .select('shirt_type, shirt_size, total_quantity, reserved_quantity, delivered_quantity')
          .eq('event_id', eventId)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    participantId
      ? supabase.rpc('get_participant_kit_items', { p_participant_id: participantId })
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    Promise.all([
      supabase.from('audit_logs').select('id, action, created_at, details').eq('entity_type', 'tickets').eq('entity_id', ticket.id).order('created_at', { ascending: false }).limit(20),
      participantId
        ? supabase.from('audit_logs').select('id, action, created_at, details').eq('entity_type', 'participants').eq('entity_id', participantId).order('created_at', { ascending: false }).limit(20)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      orderItemId
        ? supabase.from('audit_logs').select('id, action, created_at, details').eq('entity_type', 'order_items').eq('entity_id', orderItemId).order('created_at', { ascending: false }).limit(20)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ]),
    canAdminEdit && eventId
      ? supabase.rpc('get_event_ticket_categories', { p_event_id: eventId })
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ]);

  const linkedParticipants = (linkedParticipantsResult.data ?? []) as Array<Record<string, unknown>>;
  const inventoryRows = (inventoryResult.data ?? []) as Array<Record<string, unknown>>;
  const kitItems = (kitItemsResult.data ?? []) as Array<Record<string, unknown>>;
  const [ticketLogsResult, participantLogsResult, orderItemLogsResult] = timelineResult as [
    { data: Array<Record<string, unknown>> | null },
    { data: Array<Record<string, unknown>> | null },
    { data: Array<Record<string, unknown>> | null },
  ];
  const adminCategories = (categoriesResult.data ?? []) as Array<Record<string, unknown>>;

  const kitDeliveredCount = kitItems.filter((item) => String(item.status ?? '') === 'delivered').length;
  const kitSummary = kitItems.length > 0 ? `${kitDeliveredCount}/${kitItems.length} entregues` : 'Sem itens de kit';
  const inventoryBySize = new Map<string, number>();
  for (const row of inventoryRows) {
    const type = String(row.shirt_type ?? '');
    const size = String(row.shirt_size ?? '');
    const available = Math.max(0, Number(row.total_quantity ?? 0) - Number(row.reserved_quantity ?? 0) - Number(row.delivered_quantity ?? 0));
    if (type === shirtType) {
      inventoryBySize.set(size, available);
    }
  }

  const timelineItems = [
    {
      id: `ticket-issued-${ticket.id}`,
      title: 'Ingresso emitido',
      subtitle: `Pedido ${String(order?.order_number ?? '-')}`,
      date: ticket.issued_at ? formatDateTimeBR(String(ticket.issued_at), ' às ') : undefined,
      status: 'confirmed',
    },
    ...(ticket.used_at
      ? [
          {
            id: `ticket-used-${ticket.id}`,
            title: 'Check-in realizado',
            subtitle: `Ingressou em ${String(eventObj?.name ?? 'evento')}`,
            date: formatDateTimeBR(String(ticket.used_at), ' às '),
            status: 'used',
          },
        ]
      : []),
    ...(order?.confirmed_at
      ? [
          {
            id: `order-confirmed-${order.id}`,
            title: 'Pagamento confirmado',
            subtitle: `Pagamento ${String(paymentStatus)}`,
            date: formatDateTimeBR(String(order.confirmed_at), ' às '),
            status: 'confirmed',
          },
        ]
      : []),
    ...([...((ticketLogsResult.data ?? []) as Array<Record<string, unknown>>), ...((participantLogsResult.data ?? []) as Array<Record<string, unknown>>), ...((orderItemLogsResult.data ?? []) as Array<Record<string, unknown>>)]
      .map((row, index) => ({
        id: String(row.id ?? `${row.action ?? 'event'}-${row.created_at ?? index}`),
        title: (() => {
          const action = String(row.action ?? 'event');
          if (action === 'ticket_shirt_changed') return 'Camiseta alterada';
          if (action === 'ticket_category_changed') return 'Categoria alterada';
          if (action === 'ticket_notes_updated') return 'Observações atualizadas';
          if (action === 'participant_checkin_entry') return 'Check-in registrado';
          if (action.includes('kit')) return 'Kit atualizado';
          return 'Ação registrada';
        })(),
        subtitle: (() => {
          const details = row.details as Record<string, unknown> | null | undefined;
          if (!details || typeof details !== 'object') return undefined;
          if (details.next_type && details.next_size) return `${String(details.next_type)} / ${String(details.next_size)}`;
          if (details.notes) return String(details.notes);
          return undefined;
        })(),
        date: row.created_at ? formatDateTimeBR(String(row.created_at), ' às ') : undefined,
        status: 'confirmed',
      }))
      .sort((a, b) => (a.date && b.date ? new Date(b.date).getTime() - new Date(a.date).getTime() : 0))
      .slice(0, 20)),
  ] satisfies MilitrinTimelineItem[];

  const sizeOptions = SHIRT_SIZES[shirtType as keyof typeof SHIRT_SIZES] ?? [];

  async function submitDefineTicketHolder(formData: FormData) {
    'use server';
    await defineTicketHolderAction(formData);
  }

  async function submitTransferTicket(formData: FormData) {
    'use server';
    await transferTicketAction(formData);
  }

  async function submitTicketShirtChange(formData: FormData) {
    'use server';
    await changeTicketShirtAction(formData);
  }

  async function submitTicketCategoryChange(formData: FormData) {
    'use server';
    await updateTicketCategoryAction(formData);
  }

  async function submitTicketNotesChange(formData: FormData) {
    'use server';
    await updateTicketNotesAction(formData);
  }

  async function submitDeliverKit() {
    'use server';
    if (!participantId) return;
    await deliverFullKitAction({ participant_id: participantId });
  }

  async function submitCheckin() {
    'use server';
    if (!participantId) return;
    await checkinEntryAction({ participant_id: participantId });
  }

  async function submitDeliverKitAndCheckin() {
    'use server';
    await deliverKitAndCheckinAction({ ticket_id: resolvedTicketId });
  }

  return (
    <section className="space-y-4">
      <MilitrinSection
        eyebrow="Ingresso"
        title={String(eventObj?.name ?? 'Ingresso')}
        description={`Pedido ${String(order?.order_number ?? '-')} • ${holderName}`}
      >
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <div className="grid gap-2 sm:grid-cols-2">
                <p>Nome do titular: {holderName}</p>
                <p>Categoria: {String(categoryObj?.name ?? '-')}</p>
                <p>Tipo de camiseta: {shirtType}</p>
                <p>Tamanho: {shirtSize || '-'}</p>
                <p>Status pagamento: <MilitrinStatusBadge status={paymentStatus} /></p>
                <p>Status kit entregue: {kitDeliveredCount === kitItems.length && kitItems.length > 0 ? 'Entregue' : kitSummary}</p>
                <p>Status check-in: {ticket.used_at ? 'Realizado' : 'Pendente'}</p>
                <p>Pedido: {String(order?.order_number ?? '-')}</p>
                <p>Valor final: {money(Number(order?.final_amount ?? payment?.final_amount ?? 0))}</p>
                <p>Emissão: {ticket.issued_at ? formatDateTimeBR(String(ticket.issued_at), ' às ') : '-'}</p>
              </div>
            </div>

            {canShowTicket ? (
              <TicketViewer
                eventName={String(eventObj?.name ?? 'Evento')}
                participantName={holderName}
                status={ticketStatus}
                categoryName={String(categoryObj?.name ?? '-')}
                eventDate={eventObj?.starts_at ? formatDateTimeBR(String(eventObj.starts_at), ' as ') : null}
                eventLocation={eventObj?.location ? String(eventObj.location) : null}
                token={String(ticket.token ?? '')}
                orderNumber={String(order?.order_number ?? '-')}
                showPdfButton
              />
            ) : (
              <div className="rounded-2xl border border-amber-700/40 bg-amber-950/20 p-4 text-sm text-amber-100">
                O QR Code e o PDF ficam disponiveis apenas para pedidos confirmados.
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Acoes do titular</p>
              {linkedParticipants.length ? (
                <div className="mt-3 grid gap-4">
                  <form action={submitDefineTicketHolder} className="space-y-3">
                    <input type="hidden" name="ticket_id" value={String(ticket.id)} />
                    <label className="block space-y-2 text-sm">
                      <span className="text-slate-300">Definir titular</span>
                      <select name="participant_id" defaultValue={participantId || ''} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100">
                        <option value="">Selecione um participante</option>
                        {linkedParticipants.map((item) => (
                          <option key={String(item.id)} value={String(item.id)}>
                            {String(item.full_name ?? 'Participante')}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <MilitrinButton type="submit" size="sm">Definir titular</MilitrinButton>
                    </div>
                  </form>

                  <form action={submitTransferTicket} className="space-y-3">
                    <input type="hidden" name="ticket_id" value={String(ticket.id)} />
                    <label className="block space-y-2 text-sm">
                      <span className="text-slate-300">Transferir ingresso para outro participante</span>
                      <select name="participant_id" defaultValue={participantId || ''} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100">
                        <option value="">Selecione um participante</option>
                        {linkedParticipants.map((item) => (
                          <option key={String(item.id)} value={String(item.id)}>
                            {String(item.full_name ?? 'Participante')}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <MilitrinButton type="submit" size="sm" variant="secondary">Transferir ingresso</MilitrinButton>
                    </div>
                  </form>
                </div>
              ) : (
                <p className="mt-3 text-sm text-slate-300">Nenhum participante vinculado à sua conta para definir titularidade.</p>
              )}
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Alterar camiseta</p>
              <p className="mt-2 text-xs text-slate-400">
                {afterDeadline
                  ? 'Após a data limite, apenas tamanhos disponíveis podem ser escolhidos.'
                  : 'Antes da data limite, a alteração segue a política do evento.'}
              </p>
              <form action={submitTicketShirtChange} className="mt-3 space-y-3">
                <input type="hidden" name="ticket_id" value={String(ticket.id)} />
                <input type="hidden" name="shirt_type" value={shirtType} />
                <label className="block space-y-2 text-sm">
                  <span className="text-slate-300">Tamanho</span>
                  <select name="shirt_size" defaultValue={shirtSize || ''} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100">
                    <option value="">Selecione</option>
                    {sizeOptions.map((size) => {
                      const available = inventoryBySize.get(size) ?? 0;
                      const label = available < 5 ? `${size} - Restam apenas ${available}` : size;
                      return (
                        <option key={size} value={size} disabled={afterDeadline && available <= 0}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  <MilitrinButton type="submit" size="sm" variant="success">Salvar tamanho</MilitrinButton>
                </div>
              </form>
            </div>

            {canAdminEdit ? (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-slate-200">
                <p className="text-xs uppercase tracking-[0.2em] text-emerald-200">Administração</p>
                <div className="mt-3 grid gap-3">
                  {participantId ? (
                    <Link href={`/inscricoes/${participantId}/editar`} className="inline-flex">
                      <MilitrinButton size="sm" variant="secondary">Editar ingresso</MilitrinButton>
                    </Link>
                  ) : null}

                  {adminCategories.length > 0 ? (
                    <form action={submitTicketCategoryChange} className="space-y-3">
                      <input type="hidden" name="ticket_id" value={String(ticket.id)} />
                      <label className="block space-y-2 text-sm">
                        <span className="text-slate-300">Alterar categoria</span>
                        <select name="ticket_category_id" defaultValue={String(orderItem?.ticket_category_id ?? participant?.ticket_category_id ?? '')} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100">
                          <option value="">Selecione</option>
                          {adminCategories.map((item) => (
                            <option key={String(item.id)} value={String(item.id)}>
                              {String(item.name ?? 'Categoria')}
                            </option>
                          ))}
                        </select>
                      </label>
                      <MilitrinButton type="submit" size="sm" variant="secondary">Salvar categoria</MilitrinButton>
                    </form>
                  ) : null}

                  <form action={submitTicketNotesChange} className="space-y-3">
                    <input type="hidden" name="ticket_id" value={String(ticket.id)} />
                    <label className="block space-y-2 text-sm">
                      <span className="text-slate-300">Registrar observações</span>
                      <textarea name="notes" defaultValue={String(participant?.notes ?? orderItem?.notes ?? '')} rows={4} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100" />
                    </label>
                    <MilitrinButton type="submit" size="sm" variant="secondary">Salvar observações</MilitrinButton>
                  </form>

                  {participantId && canManageOperationalFlow ? (
                    <div className="flex flex-wrap gap-2">
                      <form action={submitDeliverKit}>
                        <MilitrinButton type="submit" size="sm" variant="success">Entregar kit</MilitrinButton>
                      </form>
                      <form action={submitCheckin}>
                        <MilitrinButton type="submit" size="sm" variant="warning">Fazer check-in</MilitrinButton>
                      </form>
                      <form action={submitDeliverKitAndCheckin}>
                        <MilitrinButton type="submit" size="sm">Entregar kit + check-in</MilitrinButton>
                      </form>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </MilitrinSection>

      <MilitrinSection eyebrow="Historico" title="Linha do tempo do ticket" description="Acompanhe a vida do ingresso em ordem cronologica.">
        {timelineItems.length ? <MilitrinTimeline items={timelineItems} /> : <p className="text-sm text-slate-300">Sem eventos registrados ainda.</p>}
      </MilitrinSection>

      <div className="flex flex-wrap gap-2">
        <Link href="/minha-conta/ingressos">
          <MilitrinButton variant="secondary">Voltar para ingressos</MilitrinButton>
        </Link>
        {orderId ? (
          <Link href={`/minha-conta/compras/${orderId}`}>
            <MilitrinButton>Ver compra</MilitrinButton>
          </Link>
        ) : null}
      </div>
    </section>
  );
}
