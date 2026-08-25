import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateTimeBR } from '@/lib/utils/date';
import { getCurrentPermissionMap } from '@/lib/admin/permissions';
import { MilitrinButton, MilitrinSection, MilitrinStatusBadge, MilitrinTimeline, type MilitrinTimelineItem } from '@/components/militrin';
import { TicketViewer } from '@/components/public/TicketViewer';
import {
  reviewTicketItemChangeAction,
  updateTicketNotesAction,
} from '@/app/minha-conta/actions';
import { TicketOperationalControls } from './ticket-operational-controls';
import { TicketHolderActions } from './ticket-holder-actions';
import { CategoryContextAction, HolderContextAction, ParticipantShirtChangeAction, ShirtContextAction } from './ticket-context-actions';
import { optionalDisplayValue } from '@/lib/optional-display';
import { orderDisplayReference } from '@/lib/display-reference';

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

export default async function TicketDetailPage({ params, showTimeline = true, adminEditHref }: { params: Promise<{ ticketId: string }>; showTimeline?: boolean; adminEditHref?: string }) {
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
    'kits.undo_delivery',
    'checkin.scan',
    'checkin.undo',
    'orders.resend_ticket',
    'tickets.transfer_ownership',
  ]);
  const canAdminEdit = Boolean(permissions['participants.edit_basic']);
  const canChangeShirt = Boolean(permissions['inventory.change_participant_shirt']);
  const canDeliverKit = Boolean(permissions['kits.deliver']);
  const canUndoKitDelivery = Boolean(permissions['kits.undo_delivery']);
  const canCheckin = Boolean(permissions['checkin.scan']);
  const canUndoCheckin = Boolean(permissions['checkin.undo']);
  const canManageOperationalFlow = canDeliverKit || canCheckin || canUndoKitDelivery || canUndoCheckin;
  const canTransferOwnership=Boolean(permissions['tickets.transfer_ownership']);

  const ticketSelect =
  'id, token, status, issued_at, used_at, owner_user_id, participant_id, event_id, order_id, order_item_id, events(id, name, location, starts_at, shirt_order_deadline, allow_participant_item_changes, allow_holder_change, allow_ticket_transfer), orders(id, order_number, status, user_id, buyer_type, event_id, created_at, confirmed_at, base_amount, discount_amount, final_amount, events(id, name, location, starts_at, shirt_order_deadline, allow_participant_item_changes, allow_holder_change, allow_ticket_transfer), payments!orders_payment_id_fkey(id, payment_method, payment_status, paid_at, final_amount)), order_items(id, item_position, status, holder_full_name, shirt_type, shirt_size, ticket_category_id, batch_id, participant_id, participants(id, full_name, email, user_id, shirt_type, shirt_size, ticket_category_id, ticket_categories(name)), ticket_categories(name), registration_batches(name)), participants(id, full_name, email, user_id, shirt_type, shirt_size, ticket_category_id, notes, ticket_categories(name))';
  
  const ticketResult = await supabase
    .from('tickets')
    .select(ticketSelect)
    .eq('id', ticketId)
    .maybeSingle();
  const ticketError = ticketResult.error;
  const ticket = ticketResult.data as Record<string, unknown> | null;

  if (ticketError) {
    console.log(ticketError);
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
  const eventObj = firstRelation((order?.events as Record<string, unknown> | Record<string, unknown>[] | null | undefined) ?? (ticket.events as Record<string, unknown> | Record<string, unknown>[] | null | undefined));
  // LEGACY FALLBACK — do not use as canonical source: participant category only supports incomplete historical order_items.
  const categoryObj = firstRelation((orderItem?.ticket_categories as Record<string, unknown> | Record<string, unknown>[] | null | undefined) ?? (participant?.ticket_categories as Record<string, unknown> | Record<string, unknown>[] | null | undefined));
  const batchObj = firstRelation(orderItem?.registration_batches as Record<string, unknown> | Record<string, unknown>[] | null | undefined);

  const participantId = String(orderItem?.participant_id ?? ticket.participant_id ?? participant?.id ?? '');
  const orderId = String(order?.id ?? ticket.order_id ?? '');
  const orderItemId = String(orderItem?.id ?? ticket.order_item_id ?? '');
  const eventId = String(order?.event_id ?? '');
  const isBuyer = Boolean(user?.id) && order?.buyer_type === 'account' && String(order?.user_id ?? '') === user?.id;
  const isOwner = Boolean(user?.id) && String(ticket.owner_user_id ?? '') === user?.id;
  const orderStatus = normalizeStatus(String(order?.status ?? 'pending'));
  const paymentStatus = normalizeStatus(String(payment?.payment_status ?? 'pending'));
  const ticketStatus = normalizeStatus(String(ticket.status ?? 'pending'));
  const { count: ticketIssuanceBlockCount } = participantId
    ? await supabase.from('participant_data_issues').select('id', { count: 'exact', head: true })
      .eq('participant_id', participantId).eq('status', 'open').eq('blocks_ticket_issuance', true)
    : { count: 0 };
  const ticketIssuanceBlocked = (ticketIssuanceBlockCount ?? 0) > 0;
  const canShowTicket = (isOwner || canAdminEdit) && !ticketIssuanceBlocked && (order ? orderStatus === 'confirmed' : true) && (ticketStatus === 'active' || ticketStatus === 'used');
  const hasHolder = Boolean(participantId);
  const holderName = hasHolder ? String(participant?.full_name ?? orderItem?.holder_full_name ?? 'Titular nao identificado') : 'Titular nao definido';
  const buyerProfileResult = order?.user_id
    ? await supabase.from('customer_profiles').select('full_name,email').eq('user_id', String(order.user_id)).maybeSingle()
    : { data: null };
  const buyerProfile = buyerProfileResult.data as Record<string, unknown> | null;
  const buyerName = String(buyerProfile?.full_name ?? buyerProfile?.email ?? (order?.buyer_type === 'imported_holder' ? 'Pedido importado sem comprador' : 'Comprador nao identificado'));
  const ownerProfileResult = ticket.owner_user_id
    ? await supabase.from('customer_profiles').select('full_name').eq('user_id',String(ticket.owner_user_id)).maybeSingle()
    : {data:null};
  const ownerProfile=ownerProfileResult.data as Record<string,unknown>|null;
  const ownerName=String(ownerProfile?.full_name??(ticket.owner_user_id?'Conta NEXORA':'Proprietário não definido'));

  const ensureKitResult = canAdminEdit ? await supabase.rpc('ensure_ticket_kit_items', { p_ticket_id: ticket.id }) : {data:{skipped_count:0},error:null};
  const ensureKit = (ensureKitResult.data ?? {}) as Record<string, unknown>;
  const shirtConfigurationIssue = ensureKitResult.error
    ? 'Nao foi possivel conferir os itens deste ingresso agora.'
    : Number(ensureKit.skipped_count ?? 0) > 0
      ? 'Nao foi possivel identificar a camiseta deste ingresso. Revise o tamanho antes da entrega.'
      : null;

  const [kitItemsResult, timelineResult, categoriesResult, itemRequestsResult, shirtOptionsResult] = await Promise.all([
    supabase.rpc('get_ticket_kit_items', { p_ticket_id: ticket.id }),
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
    supabase.from('ticket_item_change_requests').select('id,kit_item_id,status,current_variant,requested_variant,requested_at,event_kit_items(name)').eq('ticket_id', ticketId).order('requested_at', { ascending: false }),
    canChangeShirt
      ? supabase.rpc('get_admin_ticket_shirt_options', { p_ticket_id: ticketId })
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ]);

  const kitItems = (kitItemsResult.data ?? []) as Array<Record<string, unknown>>;
  const shirtKitItem = kitItems.find((item) => String(item.item_type ?? '') === 'shirt');
  const shirtVariant = (shirtKitItem?.variant_data ?? {}) as Record<string, unknown>;
  // LEGACY FALLBACK — do not use as canonical source: kit variant and order_item remain authoritative.
  const shirtType = optionalDisplayValue(shirtVariant.shirt_type ?? orderItem?.shirt_type ?? participant?.shirt_type);
  const shirtSize = optionalDisplayValue(shirtVariant.shirt_size ?? orderItem?.shirt_size ?? participant?.shirt_size);
  const shirtVariantId = typeof shirtVariant.variant_id === 'string' && shirtVariant.variant_id.trim().length > 0
    ? shirtVariant.variant_id.trim()
    : null;
  const shirtIsCanonicallyLinked = Boolean(shirtVariantId);
  const currentShirtOption = shirtType && shirtSize ? `${shirtType}|${shirtSize}` : '';
  const shirtKitItemId = String(shirtKitItem?.kit_item_id ?? '');
  const { data: participantShirtRuleData } = isOwner && shirtKitItemId
    ? await supabase.from('event_kit_items').select('id,item_type,requires_variant,allow_participant_change,shirt_supply_mode,event_kit_item_variants(id,name,value,is_active,sort_order,event_kit_item_variant_inventory(total_quantity,delivered_quantity))').eq('id', shirtKitItemId).maybeSingle()
    : { data: null };
  const participantShirtRule = participantShirtRuleData as Record<string, unknown> | null;
  const participantShirtVariants = (participantShirtRule?.event_kit_item_variants ?? []) as Array<Record<string, unknown>>;
  const participantShirtChangeEnabled = Boolean(isOwner
    && eventObj?.allow_participant_item_changes
    && participantShirtRule?.allow_participant_change
    && participantShirtRule?.requires_variant
    && shirtKitItemId
    && shirtType
    && shirtSize);
  const [ticketLogsResult, participantLogsResult, orderItemLogsResult] = timelineResult as [
    { data: Array<Record<string, unknown>> | null },
    { data: Array<Record<string, unknown>> | null },
    { data: Array<Record<string, unknown>> | null },
  ];
  const adminCategories = (categoriesResult.data ?? []) as Array<Record<string, unknown>>;
  const itemRequests = (itemRequestsResult.data ?? []) as Array<Record<string, unknown>>;
  const pendingItemRequests = itemRequests.filter((request) => request.status === 'pending');
  const shirtOptions = (shirtOptionsResult.data ?? []) as Array<Record<string, unknown>>;

  const kitDeliveredCount = kitItems.filter((item) => String(item.status ?? '') === 'delivered').length;
  const kitFullyDelivered = kitItems.length > 0 && kitDeliveredCount === kitItems.length;
  const checkinDone = Boolean(ticket.used_at) || ticketStatus === 'used';
  const shirtDelivered = String(shirtKitItem?.status ?? '') === 'delivered';
  const pendingShirtRequest = pendingItemRequests.some((request) => String(request.kit_item_id ?? '') === shirtKitItemId);
  const participantShirtDisabledReason = shirtDelivered
    ? 'A alteração não está disponível porque a camiseta já foi entregue.'
    : checkinDone
      ? 'A alteração não está disponível após o check-in.'
      : pendingShirtRequest
        ? 'Já existe uma alteração aguardando confirmação do organizador.'
        : null;
  const requireStockForChoice = String(participantShirtRule?.shirt_supply_mode ?? '') === 'stock';
  const participantShirtOptions = participantShirtVariants
    .filter((variant) => Boolean(variant.is_active) && String(variant.id ?? '') !== shirtVariantId)
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
    .map((variant) => {
      const inventory = firstRelation(variant.event_kit_item_variant_inventory as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
      const physicallyAvailable = Number(inventory?.total_quantity ?? 0) - Number(inventory?.delivered_quantity ?? 0);
      return { value: String(variant.id), label: `${String(variant.name ?? participantShirtRule?.item_type ?? 'Peça')} — ${String(variant.value ?? '')}`, disabled: requireStockForChoice && physicallyAvailable <= 0 };
    });
  const kitSummary = `${kitDeliveredCount}/${kitItems.length} entregues`;

  const timelineItems = [
    {
      id: `ticket-issued-${ticket.id}`,
      title: 'Ingresso emitido',
      subtitle: `Pedido ${orderDisplayReference(null, order?.order_number)}`,
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

  async function submitItemRequestReview(formData: FormData) { 'use server'; await reviewTicketItemChangeAction(formData); }

  async function submitTicketNotesChange(formData: FormData) {
    'use server';
    await updateTicketNotesAction(formData);
  }

  return (
    <section className="space-y-4">
      <MilitrinSection
        eyebrow="Ingresso"
        title={String(eventObj?.name ?? 'Ingresso')}
        description={`Pedido ${orderDisplayReference(null, order?.order_number)} • ${holderName}`}
      >
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <div className="grid gap-2 sm:grid-cols-2">
                <p className="flex flex-wrap items-center gap-2">Titular: <strong>{holderName}</strong>{canAdminEdit ? <HolderContextAction ticketId={ticketId} hasHolder={hasHolder}/> : null}</p>
                <p>Proprietário atual: <strong>{ownerName}</strong></p>
                {order ? <p>Comprador: <strong>{buyerName}</strong> <span className="text-xs text-slate-500">(original)</span></p> : null}
                {optionalDisplayValue(categoryObj?.name) ? <p className="flex flex-wrap items-center gap-2">Categoria: <strong>{optionalDisplayValue(categoryObj?.name)}</strong>{canAdminEdit ? <CategoryContextAction ticketId={ticketId} initial={String(orderItem?.ticket_category_id ?? '')} options={adminCategories.map(item=>({value:String(item.id),label:String(item.name ?? 'Categoria')}))}/> : null}</p> : null}
                {optionalDisplayValue(batchObj?.name) ? <p>Lote: {optionalDisplayValue(batchObj?.name)}</p> : null}
                {(shirtKitItem || shirtType || shirtSize) ? <p className="flex flex-wrap items-center gap-2">Camiseta: <strong>{shirtType && shirtSize ? `${shirtType} ${shirtSize}` : 'Nao identificada'}</strong>{canChangeShirt ? <ShirtContextAction ticketId={ticketId} initial={currentShirtOption} options={shirtOptions.map(option=>({value:`${String(option.shirt_type)}|${String(option.shirt_size)}`,label:String(option.option_label)}))}/> : null}</p> : null}
                <p>Pagamento: <MilitrinStatusBadge status={paymentStatus} /></p>
                {kitItems.length > 0 ? <p>Status kit entregue: {kitDeliveredCount === kitItems.length ? 'Entregue' : kitSummary}</p> : null}
                <p>Status check-in: {ticket.used_at ? 'Realizado' : 'Pendente'}</p>
                <p>Pedido: {orderDisplayReference(null, order?.order_number)}</p>
                <p>Valor final: {money(Number(order?.final_amount ?? payment?.final_amount ?? 0))}</p>
                {ticket.issued_at ? <p>Emissão: {formatDateTimeBR(String(ticket.issued_at), ' às ')}</p> : null}
              </div>
              {shirtConfigurationIssue ? <p className="mt-3 rounded-xl border border-amber-600/30 bg-amber-950/20 p-3 text-xs text-amber-100">{shirtConfigurationIssue}</p> : null}
              {participantId && canManageOperationalFlow ? <div className="mt-4 border-t border-slate-800 pt-4"><p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">Ações de kit e check-in</p><TicketOperationalControls ticketId={ticketId} kitFullyDelivered={kitFullyDelivered} kitReadyForDelivery={!shirtKitItem || shirtIsCanonicallyLinked} checkinDone={checkinDone} hasActiveWristband={false} canDeliverKit={canDeliverKit} canUndoKitDelivery={canUndoKitDelivery} canCheckin={canCheckin} canUndoCheckin={canUndoCheckin}/></div> : null}
            </div>

            {canShowTicket ? (
              <div id="qr"><TicketViewer
                eventName={String(eventObj?.name ?? 'Evento')}
                participantName={holderName}
                status={ticketStatus}
                categoryName={optionalDisplayValue(categoryObj?.name)}
                eventDate={eventObj?.starts_at ? String(eventObj.starts_at) : null}
                eventLocation={eventObj?.location ? String(eventObj.location) : null}
                token={String(ticket.token ?? '')}
                orderNumber={orderDisplayReference(null, order?.order_number)}
                showPdfButton
              /></div>
            ) : (
              <div className="rounded-2xl border border-amber-700/40 bg-amber-950/20 p-4 text-sm text-amber-100">
                {ticketIssuanceBlocked ? 'Ingresso aguardando conferência. O QR Code ficará disponível após a liberação do organizador.' : 'O QR Code e o PDF ficam disponíveis apenas para pedidos confirmados.'}
              </div>
            )}
          </div>

          <div className="space-y-4">
            {kitItems.length ? <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Itens ativos do kit</p>
              <ul className="mt-3 space-y-2">
                {kitItems.map((item) => <li key={String(item.kit_item_id)} className="flex items-center justify-between gap-3">
                  <span>{String(item.item_name ?? 'Item')}</span>
                  <span className="text-xs text-slate-400">{String(item.item_type) === 'shirt' && String(item.status) === 'not_linked' ? 'Camiseta não vinculada' : String(item.status ?? 'pendente')}</span>
                </li>)}
              </ul>
            </div> : null}
            {isOwner && (((!participantId && Boolean(eventObj?.allow_holder_change)) || (participantId && Boolean(eventObj?.allow_ticket_transfer))) || participantShirtChangeEnabled) ? <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Ações do ingresso</p>
              {((!participantId && Boolean(eventObj?.allow_holder_change)) || (participantId && Boolean(eventObj?.allow_ticket_transfer))) ? <div className="mt-3">{!participantId ? <TicketHolderActions ticketId={ticketId} mode="define" /> : <TicketHolderActions ticketId={ticketId} mode="transfer" />}</div> : null}
              {participantShirtChangeEnabled ? <ParticipantShirtChangeAction ticketId={ticketId} kitItemId={shirtKitItemId} currentLabel={`${shirtType} — ${shirtSize}`} options={participantShirtOptions} disabledReason={participantShirtDisabledReason} /> : null}
            </div> : null}

            {isBuyer && kitItems.length > 0 ? <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <p>Itens: {kitItems.length} vinculado(s)</p>
              {pendingItemRequests.length ? <p className="mt-2 text-amber-200">{pendingItemRequests.length} alteração(ões) aguardando confirmação</p> : null}
              <Link href={`/minha-conta/ingressos/${ticketId}/itens`} className="mt-3 inline-flex rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200">Gerenciar itens</Link>
            </div> : null}

            {canAdminEdit ? (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-slate-200">
                <p className="text-xs uppercase tracking-[0.2em] text-emerald-200">Administração</p>
                <div className="mt-3 grid gap-3">
                  {pendingItemRequests.map((request) => {
                    const item = firstRelation(request.event_kit_items as Record<string, unknown> | Record<string, unknown>[] | null); const current = request.current_variant as Record<string, unknown> | null; const requested = request.requested_variant as Record<string, unknown> | null;
                    return <div key={String(request.id)} className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                      <p className="font-medium text-amber-100">{String(item?.name ?? 'Item')}</p>
                      <p className="mt-1 text-xs text-amber-200">{String(current?.name ?? current?.value ?? 'Atual')} → {String(requested?.name ?? requested?.value ?? 'Solicitada')}</p>
                      <form action={submitItemRequestReview} className="mt-3 flex flex-wrap gap-2">
                        <input type="hidden" name="request_id" value={String(request.id)} />
                        <input type="hidden" name="ticket_id" value={ticketId} />
                        <button name="decision" value="approved" className="rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-slate-950">Aprovar</button>
                        <button name="decision" value="rejected" className="rounded-lg border border-rose-500/50 px-3 py-1.5 text-xs text-rose-200">Rejeitar</button>
                      </form>
                    </div>;
                  })}
                  {participantId ? (
                    <Link href={adminEditHref ?? `/ingressos/${ticketId}/editar`} className="inline-flex">
                      <MilitrinButton size="sm" variant="secondary">Editar ingresso</MilitrinButton>
                    </Link>
                  ) : null}
                  {canTransferOwnership?<Link href={`${adminEditHref ?? `/ingressos/${ticketId}/editar`}#propriedade`} className="inline-flex"><MilitrinButton size="sm" variant="secondary">Transferir propriedade</MilitrinButton></Link>:null}

                  <form action={submitTicketNotesChange} className="space-y-3">
                    <input type="hidden" name="ticket_id" value={String(ticket.id)} />
                    <label className="block space-y-2 text-sm">
                      <span className="text-slate-300">Registrar observações</span>
                      <textarea name="notes" defaultValue={String(participant?.notes ?? orderItem?.notes ?? '')} rows={4} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100" />
                    </label>
                    <MilitrinButton type="submit" size="sm" variant="secondary">Salvar observações</MilitrinButton>
                  </form>

                </div>
              </div>
            ) : null}
          </div>
        </div>
      </MilitrinSection>

      {showTimeline ? <MilitrinSection eyebrow="Histórico" title="Linha do tempo do ingresso" description="Acompanhe a vida do ingresso em ordem cronológica.">
        {timelineItems.length ? <MilitrinTimeline items={timelineItems} /> : <p className="text-sm text-slate-300">Sem eventos registrados ainda.</p>}
      </MilitrinSection> : null}

      <div className="flex flex-wrap gap-2">
        <Link href="/minha-conta/ingressos">
          <MilitrinButton variant="secondary">Voltar para ingressos</MilitrinButton>
        </Link>
        {orderId && isBuyer ? (
          <Link href={`/minha-conta/compras/${orderId}`}>
            <MilitrinButton>Ver compra</MilitrinButton>
          </Link>
        ) : null}
      </div>
    </section>
  );
}
