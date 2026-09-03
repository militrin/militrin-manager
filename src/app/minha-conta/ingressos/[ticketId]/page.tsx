import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CalendarDays, CheckCircle2, MapPin, Shirt, Ticket as TicketIcon } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateLongBR, formatDateTimeBR } from '@/lib/utils/date';
import { getCurrentPermissionMap } from '@/lib/admin/permissions';
import {
  MilitrinBadge,
  MilitrinButton,
  MilitrinHeader,
  MilitrinLinkButton,
  MilitrinSection,
  MilitrinStatusBadge,
  MilitrinTimeline,
  checkinStatusChip,
  cx,
  militrinTokens,
  militrinType,
  type MilitrinTimelineItem,
} from '@/components/militrin';
import { buildAccountHeaderEvent } from '@/lib/account/header-event';
import { generateQrDataUrl } from '@/lib/qr/generate-qr-data-url';
import { TicketPdfButton } from '@/components/public/TicketPdfButton';
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
  'id, token, status, issued_at, used_at, owner_user_id, participant_id, event_id, order_id, order_item_id, events(id, name, location, starts_at, ends_at, shirt_order_deadline, allow_participant_item_changes, allow_holder_change, allow_ticket_transfer), orders(id, order_number, status, user_id, buyer_type, event_id, created_at, confirmed_at, base_amount, discount_amount, final_amount, events(id, name, location, starts_at, ends_at, shirt_order_deadline, allow_participant_item_changes, allow_holder_change, allow_ticket_transfer), payments!orders_payment_id_fkey(id, payment_method, payment_status, paid_at, final_amount)), order_items(id, item_position, status, holder_full_name, shirt_type, shirt_size, ticket_category_id, batch_id, participant_id, participants(id, full_name, email, user_id, shirt_type, shirt_size, ticket_category_id, ticket_categories(name)), ticket_categories(name), registration_batches(name)), participants(id, full_name, email, user_id, shirt_type, shirt_size, ticket_category_id, notes, ticket_categories(name))';
  
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
  const ticketStatus = normalizeStatus(String(ticket.status ?? 'pending'));
  // Mesma semantica canonica de "pago" usada pelo Dashboard
  // (resolveCommercialStatus, src/lib/dashboard/commercial-status.ts) e pela
  // RPC admin_update_ticket_category -- nunca confiar so em orders.status,
  // que pode ficar preso em valor pre-confirmacao mesmo com o pagamento ja
  // liquidado em payments.payment_status. So controla quando a UI mostra o
  // aviso/motivo obrigatorio; a RPC repete a mesma checagem no backend.
  const isTicketPaidForCategoryLock = orderStatus === 'confirmed'
    || normalizeStatus(String(orderItem?.status ?? '')) === 'confirmed'
    || normalizeStatus(String(payment?.payment_status ?? '')) === 'confirmed';
  const { count: ticketIssuanceBlockCount } = participantId
    ? await supabase.from('participant_data_issues').select('id', { count: 'exact', head: true })
      .eq('participant_id', participantId).eq('status', 'open').eq('blocks_ticket_issuance', true)
    : { count: 0 };
  const ticketIssuanceBlocked = (ticketIssuanceBlockCount ?? 0) > 0;
  const canShowTicket = (isOwner || canAdminEdit) && !ticketIssuanceBlocked && (order ? orderStatus === 'confirmed' : true) && (ticketStatus === 'active' || ticketStatus === 'used');
  let qrDataUrl: string | null = null;
  if (canShowTicket && ticket.token) {
    try {
      qrDataUrl = await generateQrDataUrl(String(ticket.token), 320);
    } catch {
      qrDataUrl = null;
    }
  }
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
    supabase.from('ticket_item_change_requests').select('id,kit_item_id,status,current_variant,requested_variant,requested_at,review_notes,event_kit_items(name)').eq('ticket_id', ticketId).order('requested_at', { ascending: false }),
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
  // Ultima solicitacao de camiseta ja revisada (aprovada/rejeitada), pro
  // participante ver o desfecho aqui tambem -- sem isso, "aguardando
  // confirmacao" desaparecia da tela sem nunca mostrar o resultado. itemRequests
  // ja vem ordenado por requested_at desc, entao o primeiro match e o mais
  // recente. So mostra quando NAO ha pedido pendente (senao o aviso de
  // "aguardando" acima ja cobre o estado atual).
  const latestReviewedShirtRequest = !pendingShirtRequest
    ? itemRequests.find((request) => String(request.kit_item_id ?? '') === shirtKitItemId && request.status !== 'pending')
    : null;
  const shirtLastOutcome = latestReviewedShirtRequest
    ? latestReviewedShirtRequest.status === 'approved'
      ? { status: 'approved' as const, label: String((latestReviewedShirtRequest.requested_variant as Record<string, unknown> | null)?.name ?? (latestReviewedShirtRequest.requested_variant as Record<string, unknown> | null)?.value ?? 'novo valor') }
      : { status: 'rejected' as const, reviewNotes: latestReviewedShirtRequest.review_notes ? String(latestReviewedShirtRequest.review_notes) : null }
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

  // O kit e UMA entrega só pro participante, mesmo com varios registros em
  // participant_kit_items (camiseta/copo/tirante/porta-copo etc.) --
  // reaproveita exatamente kitFullyDelivered/kitDeliveredCount (ja
  // calculados acima, fonte canonica unica) pro rotulo agregado, nunca um
  // status por item. Item cancelado nao aparece na lista pro participante
  // (nao faz sentido "incluir" algo cancelado), mas nao muda o calculo do
  // agregado, que ja e a fonte existente.
  const kitItemsForDisplay = kitItems.filter((item) => String(item.status ?? '') !== 'cancelled');
  const kitDeliveredAt = kitItems.find((item) => String(item.status ?? '') === 'delivered')?.delivered_at as string | null | undefined;
  const checkinChip = checkinStatusChip(checkinDone);
  const eventDateLong = eventObj?.starts_at ? formatDateLongBR(String(eventObj.starts_at)) : null;
  const headerEvent = buildAccountHeaderEvent({
    name: eventObj?.name ? String(eventObj.name) : null,
    starts_at: eventObj?.starts_at ? String(eventObj.starts_at) : null,
    ends_at: eventObj?.ends_at ? String(eventObj.ends_at) : null,
    location: eventObj?.location ? String(eventObj.location) : null,
  });
  // Secao "Administracao" -- so o que exige permissao administrativa
  // (participants.edit_basic ou kits/checkin). Definir/transferir titular
  // (TicketHolderActions) e uma capacidade do PROPRIO dono do ingresso
  // (regra de titularidade existente, gated por isOwner + flags do evento),
  // nao administrativa -- continua na area do participante, nao aqui.
  const hasAdminSection = Boolean(canAdminEdit || (participantId && canManageOperationalFlow));
  const showHolderActions = isOwner && ((!participantId && Boolean(eventObj?.allow_holder_change)) || (participantId && Boolean(eventObj?.allow_ticket_transfer)));

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
            subtitle: payment?.payment_method ? `Via ${String(payment.payment_method).toUpperCase()}` : undefined,
            date: formatDateTimeBR(String(order.confirmed_at), ' às '),
            status: 'confirmed',
          },
        ]
      : []),
    ...(kitItems.length > 0 && order?.confirmed_at
      ? [
          kitFullyDelivered
            ? {
                id: `kit-delivered-${ticket.id}`,
                title: 'Kit retirado',
                subtitle: undefined,
                date: kitDeliveredAt ? formatDateTimeBR(String(kitDeliveredAt), ' às ') : undefined,
                status: 'confirmed',
              }
            : {
                id: `kit-pending-${ticket.id}`,
                title: 'Aguardando retirada do kit',
                subtitle: 'Apresente o QR Code no evento para retirar.',
                date: undefined,
                status: 'pending',
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
      <MilitrinHeader event={headerEvent} showBuyButton={false} />

      <Link href="/minha-conta/ingressos" className={cx('inline-flex items-center gap-1.5', militrinType.micro)}>
        ← Voltar para meus ingressos
      </Link>

      {/* Cabecalho: cartao de identidade do ingresso -- sem termos tecnicos, sem uuid. */}
      <div className={cx(militrinTokens.radius, militrinTokens.surface, militrinTokens.shadow, 'p-5 sm:p-6')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={militrinTokens.eyebrow}>Ingresso</p>
            <h1 className={cx('mt-1 truncate', militrinType.pageTitle)} title={String(eventObj?.name ?? 'Ingresso')}>{String(eventObj?.name ?? 'Ingresso')}</h1>
            <p className={cx('mt-1', militrinType.micro)}>
              Pedido {orderDisplayReference(null, order?.order_number)}
              {ticket.issued_at ? ` • Emitido em ${formatDateTimeBR(String(ticket.issued_at), ' às ')}` : ''}
            </p>
          </div>
          <MilitrinStatusBadge status={ticketStatus} />
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {optionalDisplayValue(batchObj?.name) ? (
            <div className="min-w-0">
              <p className={militrinType.label}>Lote</p>
              <p className={cx('truncate', militrinType.body)}>{optionalDisplayValue(batchObj?.name)}</p>
            </div>
          ) : null}
          {eventDateLong ? (
            <div className="min-w-0">
              <p className={militrinType.label}>Data do evento</p>
              <p className={cx('flex items-center gap-1.5', militrinType.body)}><CalendarDays size={13} className="shrink-0 text-slate-500" /><span className="truncate">{eventDateLong}</span></p>
            </div>
          ) : null}
          {optionalDisplayValue(eventObj?.location) ? (
            <div className="min-w-0">
              <p className={militrinType.label}>Local</p>
              <p className={cx('flex items-center gap-1.5', militrinType.body)}><MapPin size={13} className="shrink-0 text-slate-500" /><span className="truncate">{optionalDisplayValue(eventObj?.location)}</span></p>
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-slate-800/80 pt-4">
          <div className="min-w-0">
            <p className={militrinType.label}>Titular</p>
            <p className={cx('truncate', militrinType.body)}>{holderName}</p>
          </div>
          {optionalDisplayValue(categoryObj?.name) ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/70 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-200">
              <TicketIcon size={11} />{optionalDisplayValue(categoryObj?.name)}
            </span>
          ) : null}
          {shirtSize ? (
            <div className="min-w-0">
              <p className={militrinType.label}>Camiseta</p>
              <p className={cx('flex items-center gap-1.5', militrinType.body)}><Shirt size={13} className="shrink-0 text-slate-500" />{shirtSize}</p>
            </div>
          ) : null}
          <div className="ml-auto">
            <MilitrinBadge tone={checkinChip.tone}>
              <span className="inline-flex items-center gap-1"><checkinChip.icon size={11} />{checkinChip.label}</span>
            </MilitrinBadge>
          </div>
        </div>
      </div>

      {/* Seu ingresso (QR) + Seu kit -- lado a lado no desktop, empilhados no mobile. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={cx(militrinTokens.radiusMd, militrinTokens.surfaceMuted, militrinTokens.shadow, 'p-4 sm:p-5')}>
          <h2 className={militrinType.cardTitle}>Seu ingresso</h2>
          {canShowTicket ? (
            <div id="qr" className="mt-4 flex flex-col items-center gap-3">
              <p className={cx('text-center', militrinType.body)}>
                Apresente este QR Code para <strong className="text-white">retirar seu kit</strong>.
              </p>
              <div className="rounded-2xl border border-slate-700 bg-white p-3">
                {qrDataUrl ? (
                  <Image src={qrDataUrl} alt="QR Code do ingresso" width={220} height={220} unoptimized className="h-55 w-55" />
                ) : (
                  <p className="p-6 text-sm text-slate-500">Não foi possível gerar o QR Code.</p>
                )}
              </div>
              <TicketPdfButton
                eventName={String(eventObj?.name ?? 'Evento')}
                participantName={holderName}
                status={ticketStatus}
                categoryName={optionalDisplayValue(categoryObj?.name)}
                eventDate={eventObj?.starts_at ? String(eventObj.starts_at) : null}
                eventLocation={eventObj?.location ? String(eventObj.location) : null}
                token={String(ticket.token ?? '')}
                orderNumber={orderDisplayReference(null, order?.order_number)}
                className={cx('mt-1 inline-flex w-full items-center justify-center gap-2 rounded-2xl font-semibold transition sm:w-auto', militrinTokens.focusRing, 'bg-linear-to-r from-(--brand-600) to-(--brand-500) text-white shadow-lg shadow-(--brand-600)/25 hover:from-(--brand-500) hover:to-(--brand-400) h-11 px-5 text-sm')}
              />
            </div>
          ) : (
            <div className="mt-4 rounded-2xl border border-amber-700/40 bg-amber-950/20 p-4 text-sm text-amber-100">
              {ticketIssuanceBlocked ? 'Ingresso aguardando conferência. O QR Code ficará disponível após a liberação do organizador.' : 'O QR Code fica disponível assim que o pagamento é confirmado.'}
            </div>
          )}
        </div>

        {kitItemsForDisplay.length ? (
          <div className={cx(militrinTokens.radiusMd, militrinTokens.surfaceMuted, militrinTokens.shadow, 'p-4 sm:p-5')}>
            <div className="flex items-center justify-between gap-2">
              <h2 className={militrinType.cardTitle}>Seu kit</h2>
              <MilitrinBadge tone={kitFullyDelivered ? 'success' : 'neutral'}>{kitFullyDelivered ? 'Kit retirado' : 'A retirar'}</MilitrinBadge>
            </div>
            <p className={cx('mt-1', militrinType.micro)}>{kitItemsForDisplay.length} {kitItemsForDisplay.length === 1 ? 'item incluído' : 'itens incluídos'}</p>
            <ul className="mt-3 space-y-2">
              {kitItemsForDisplay.map((item) => {
                const isShirtRow = String(item.item_type) === 'shirt';
                const notLinked = isShirtRow && String(item.status) === 'not_linked';
                return (
                  <li key={String(item.kit_item_id)} className="flex items-center gap-2">
                    <CheckCircle2 size={15} className={notLinked ? 'shrink-0 text-slate-600' : 'shrink-0 text-emerald-400'} />
                    <span className={militrinType.body}>{String(item.item_name ?? 'Item')}</span>
                    {isShirtRow && shirtSize ? <span className={militrinType.micro}>— {shirtSize}</span> : null}
                  </li>
                );
              })}
            </ul>
            <p className={cx('mt-3 border-t border-slate-800/80 pt-3', militrinType.micro)}>
              Todos os itens do kit são retirados juntos com o QR Code do seu ingresso.
              {kitFullyDelivered && kitDeliveredAt ? ` Retirado em ${formatDateTimeBR(String(kitDeliveredAt), ' às ')}.` : ''}
            </p>
            {participantShirtChangeEnabled ? (
              <div className="mt-3 border-t border-slate-800/80 pt-3">
                <ParticipantShirtChangeAction ticketId={ticketId} kitItemId={shirtKitItemId} currentLabel={`${shirtType} — ${shirtSize}`} options={participantShirtOptions} disabledReason={participantShirtDisabledReason} lastOutcome={shirtLastOutcome} />
              </div>
            ) : null}
            {shirtConfigurationIssue ? <p className="mt-3 rounded-xl border border-amber-600/30 bg-amber-950/20 p-3 text-xs text-amber-100">{shirtConfigurationIssue}</p> : null}
          </div>
        ) : null}
      </div>

      {/* Detalhes do ingresso -- so informacoes que fazem sentido pro participante, sem uuid/status cru. */}
      <div className={cx(militrinTokens.radiusMd, militrinTokens.surfaceMuted, militrinTokens.shadow, 'p-4 sm:p-5')}>
        <h2 className={militrinType.cardTitle}>Detalhes do ingresso</h2>
        <div className="mt-3 divide-y divide-slate-800/80 text-sm">
          {optionalDisplayValue(categoryObj?.name) ? <div className="flex items-center justify-between gap-3 py-2"><span className={militrinType.bodyMuted}>Categoria</span><span className={militrinType.body}>{optionalDisplayValue(categoryObj?.name)}</span></div> : null}
          {optionalDisplayValue(batchObj?.name) ? <div className="flex items-center justify-between gap-3 py-2"><span className={militrinType.bodyMuted}>Lote</span><span className={militrinType.body}>{optionalDisplayValue(batchObj?.name)}</span></div> : null}
          <div className="flex items-center justify-between gap-3 py-2"><span className={militrinType.bodyMuted}>Valor pago</span><span className={militrinType.money}>{money(Number(order?.final_amount ?? payment?.final_amount ?? 0))}</span></div>
          {optionalDisplayValue(payment?.payment_method as string | null) ? <div className="flex items-center justify-between gap-3 py-2"><span className={militrinType.bodyMuted}>Forma de pagamento</span><span className={militrinType.body}>{String(payment?.payment_method).toUpperCase()}</span></div> : null}
          <div className="flex items-center justify-between gap-3 py-2"><span className={militrinType.bodyMuted}>Status do pedido</span><MilitrinStatusBadge status={orderStatus} /></div>
          {ticket.issued_at ? <div className="flex items-center justify-between gap-3 py-2"><span className={militrinType.bodyMuted}>Emitido em</span><span className={militrinType.body}>{formatDateTimeBR(String(ticket.issued_at), ' às ')}</span></div> : null}
        </div>
      </div>

      {showHolderActions ? (
        <div className={cx(militrinTokens.radiusMd, militrinTokens.surfaceMuted, militrinTokens.shadow, 'p-4 sm:p-5')}>
          <h2 className={militrinType.cardTitle}>Titular do ingresso</h2>
          <div className="mt-3">{!participantId ? <TicketHolderActions ticketId={ticketId} mode="define" /> : <TicketHolderActions ticketId={ticketId} mode="transfer" />}</div>
        </div>
      ) : null}

      <div className={cx(militrinTokens.radiusMd, militrinTokens.surfaceMuted, militrinTokens.shadow, 'p-4 sm:p-5')}>
        <h2 className={militrinType.cardTitle}>Informações importantes</h2>
        <ul className="mt-3 space-y-2">
          <li className={cx('flex items-start gap-2', militrinType.body)}><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-400" />Chegue com antecedência para retirar seu kit.</li>
          <li className={cx('flex items-start gap-2', militrinType.body)}><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-400" />O ingresso é pessoal e intransferível.</li>
          <li className={cx('flex items-start gap-2', militrinType.body)}><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-400" />Em caso de dúvidas, fale com a organização.</li>
        </ul>
      </div>

      {showTimeline ? (
        <MilitrinSection eyebrow="Histórico" title="Histórico do ingresso" description="Acompanhe a vida do ingresso em ordem cronológica.">
          {timelineItems.length ? <MilitrinTimeline items={timelineItems} /> : <p className={militrinType.bodyMuted}>Sem eventos registrados ainda.</p>}
        </MilitrinSection>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <MilitrinLinkButton href="/minha-conta/ingressos" variant="secondary" size="md" className="w-full sm:w-auto">Voltar para ingressos</MilitrinLinkButton>
        {orderId && isBuyer ? <MilitrinLinkButton href={`/minha-conta/compras/${orderId}`} variant="secondary" size="md" className="w-full sm:w-auto">Ver compra</MilitrinLinkButton> : null}
      </div>

      {/* Administracao -- exclusivamente admin/operacional, sempre separado da experiencia do participante acima, independente de quem estiver logado. */}
      {hasAdminSection ? (
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-slate-200 sm:p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-200">Administração</p>
          <div className="mt-3 grid gap-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <p className="flex flex-wrap items-center gap-2">Titular: <strong>{holderName}</strong><HolderContextAction ticketId={ticketId} hasHolder={hasHolder} /></p>
              <p>Proprietário atual: <strong>{ownerName}</strong></p>
              {order ? <p>Comprador: <strong>{buyerName}</strong> <span className="text-xs text-slate-500">(original)</span></p> : null}
              {optionalDisplayValue(categoryObj?.name) ? (
                <p className="flex flex-wrap items-center gap-2">
                  Categoria: <strong>{optionalDisplayValue(categoryObj?.name)}</strong>
                  {canAdminEdit ? (
                    <CategoryContextAction
                      ticketId={ticketId}
                      initial={String(orderItem?.ticket_category_id ?? '')}
                      options={adminCategories.map(item=>({value:String(item.id),label:String(item.name ?? 'Categoria')}))}
                      orderConfirmed={isTicketPaidForCategoryLock}
                      checkedIn={checkinDone}
                    />
                  ) : null}
                </p>
              ) : null}
              {(shirtKitItem || shirtType || shirtSize) && canChangeShirt ? <p className="flex flex-wrap items-center gap-2">Camiseta: <strong>{shirtType && shirtSize ? `${shirtType} ${shirtSize}` : 'Nao identificada'}</strong><ShirtContextAction ticketId={ticketId} initial={currentShirtOption} options={shirtOptions.map(option=>({value:`${String(option.shirt_type)}|${String(option.shirt_size)}`,label:String(option.option_label)}))}/></p> : null}
              {kitItems.length > 0 ? <p>Status kit entregue: {kitDeliveredCount === kitItems.length ? 'Entregue' : kitSummary}</p> : null}
            </div>

            {participantId && canManageOperationalFlow ? (
              <div className="border-t border-slate-800 pt-3">
                <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">Ações de kit e check-in</p>
                <TicketOperationalControls ticketId={ticketId} kitFullyDelivered={kitFullyDelivered} kitReadyForDelivery={!shirtKitItem || shirtIsCanonicallyLinked} checkinDone={checkinDone} hasActiveWristband={false} canDeliverKit={canDeliverKit} canUndoKitDelivery={canUndoKitDelivery} canCheckin={canCheckin} canUndoCheckin={canUndoCheckin}/>
              </div>
            ) : null}

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
            {canAdminEdit && participantId ? (
              <Link href={adminEditHref ?? `/ingressos/${ticketId}/editar`} className="inline-flex">
                <MilitrinButton size="sm" variant="secondary">Editar ingresso</MilitrinButton>
              </Link>
            ) : null}
            {canAdminEdit && canTransferOwnership ? <Link href={`${adminEditHref ?? `/ingressos/${ticketId}/editar`}#propriedade`} className="inline-flex"><MilitrinButton size="sm" variant="secondary">Transferir propriedade</MilitrinButton></Link> : null}

            {canAdminEdit ? (
              <form action={submitTicketNotesChange} className="space-y-3">
                <input type="hidden" name="ticket_id" value={String(ticket.id)} />
                <label className="block space-y-2 text-sm">
                  <span className="text-slate-300">Registrar observações</span>
                  <textarea name="notes" defaultValue={String(participant?.notes ?? orderItem?.notes ?? '')} rows={4} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100" />
                </label>
                <MilitrinButton type="submit" size="sm" variant="secondary">Salvar observações</MilitrinButton>
              </form>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
