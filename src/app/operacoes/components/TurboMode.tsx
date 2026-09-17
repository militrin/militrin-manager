'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { OperationEvent, OperationTicketDetails, OperationTicketRow, PickupCapabilities, TurboSearchHit } from '../types';
import type { OperationalProductItem } from '@/lib/operations/operational-product-item';
import { SOURCE_LABEL } from '@/lib/operations/operational-product-item';
import {
  deliverKitAndCheckinAction,
  deliverKitCheckinAndLinkWristbandAction,
  deliverOperationalProductItemAction,
  getOperationCapabilitiesAction,
  getOperationTicketDetailsAction,
  resolveTurboScanAction,
  searchTurboOperationsAction,
  undoCheckinEntryAction,
  undoFullKitDeliveryAction,
  undoOperationalProductDeliveryAction,
} from '../actions';
import { remainingTurboTicketAction } from '@/lib/operations/ticket-operation-gate';
import { describeTurboCaughtError, getOperationalErrorTitle } from '../error-messages';
import { QrScanner } from './QrScanner';
import { ReasonDialog } from './ReasonDialog';

const AUTO_RETURN_MS = 1600;

function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

const OFFLINE_COPY = {
  title: 'Sem conexão',
  message: 'Sem internet. Não confirme agora. Quando voltar, leia o QR de novo para ver o estado real.',
};

// Maquina de estados explicita (pedido: nunca vários booleans concorrentes
// que deixem a UI num estado impossível). Cada tela do Turbo corresponde a
// exatamente um "kind" aqui; a transição sempre passa pelo reducer abaixo.
//
// "product_review"/"product_already_delivered" cobrem QUALQUER um dos dois
// canais de produto (loja standalone OU "compre junto") -- o formato
// canonico OperationalProductItem ja carrega `source` pra quando a acao
// precisar saber em qual dominio atuar (deliverOperationalProductItemAction),
// mas a UI nunca mais bifurca por canal.
type TurboScreen =
  | { kind: 'scanning_initial' }
  | { kind: 'searching' }
  | { kind: 'ticket_review'; participant: OperationTicketDetails }
  | { kind: 'scanning_wristband'; participant: OperationTicketDetails }
  | { kind: 'ticket_success'; message: string; extra: string | null; participant: OperationTicketDetails | null }
  | { kind: 'product_review'; item: OperationalProductItem }
  | { kind: 'product_choices'; items: OperationalProductItem[] }
  // Segunda leitura (ou qualquer leitura depois da primeira entrega) do
  // MESMO QR: nunca reprocessa, nunca mostra so um erro/toast -- abre o
  // resumo da entrega original (produto/pedido/comprador/evento/data-hora/
  // operador), com um botao explicito de volta ao leitor.
  | { kind: 'product_already_delivered'; item: OperationalProductItem }
  | { kind: 'product_success'; item: OperationalProductItem | null }
  // participant presente so quando o erro veio da ETAPA de pulseira -- deixa
  // o operador tentar outra pulseira pro MESMO ingresso (sem re-escanear o
  // ingresso do zero) em vez de so poder cancelar tudo.
  | { kind: 'error'; title: string; message: string; ticketId: string | null; participant: OperationTicketDetails | null; tone: 'block' | 'attention' };

type TurboAction =
  | { type: 'SCAN_TICKET'; participant: OperationTicketDetails }
  | { type: 'SCAN_PRODUCT'; item: OperationalProductItem }
  | { type: 'SCAN_PRODUCT_CHOICES'; items: OperationalProductItem[] }
  | { type: 'SCAN_PRODUCT_DELIVERED'; item: OperationalProductItem }
  | { type: 'SCAN_ERROR'; title: string; message: string; tone?: 'block' | 'attention' }
  | { type: 'OPEN_SEARCH' }
  | { type: 'GO_TO_WRISTBAND' }
  | { type: 'RETRY_WRISTBAND'; participant: OperationTicketDetails }
  | { type: 'TICKET_DONE'; message: string; extra: string | null; participant: OperationTicketDetails }
  | { type: 'PRODUCT_DONE'; item: OperationalProductItem }
  | { type: 'FAIL'; title: string; message: string; ticketId: string | null; participant?: OperationTicketDetails | null; tone?: 'block' | 'attention' }
  | { type: 'RESET' };

function reducer(state: TurboScreen, action: TurboAction): TurboScreen {
  switch (action.type) {
    case 'SCAN_TICKET':
      return { kind: 'ticket_review', participant: action.participant };
    case 'SCAN_PRODUCT':
      return { kind: 'product_review', item: action.item };
    case 'SCAN_PRODUCT_CHOICES':
      return { kind: 'product_choices', items: action.items };
    case 'SCAN_PRODUCT_DELIVERED':
      return { kind: 'product_already_delivered', item: action.item };
    case 'SCAN_ERROR':
      return { kind: 'error', title: action.title, message: action.message, ticketId: null, participant: null, tone: action.tone ?? 'block' };
    case 'OPEN_SEARCH':
      return { kind: 'searching' };
    case 'GO_TO_WRISTBAND':
      return state.kind === 'ticket_review' ? { kind: 'scanning_wristband', participant: state.participant } : state;
    case 'RETRY_WRISTBAND':
      return { kind: 'scanning_wristband', participant: action.participant };
    case 'TICKET_DONE':
      return { kind: 'ticket_success', message: action.message, extra: action.extra, participant: action.participant };
    case 'PRODUCT_DONE':
      return { kind: 'product_success', item: action.item };
    case 'FAIL':
      return {
        kind: 'error',
        title: action.title,
        message: action.message,
        ticketId: action.ticketId,
        participant: action.participant ?? null,
        tone: action.tone ?? 'block',
      };
    case 'RESET':
      return { kind: 'scanning_initial' };
    default:
      return state;
  }
}

function getTicketBlockers(participant: OperationTicketDetails): string[] {
  const blockers: string[] = [];
  if (participant.ticket_status === 'cancelled') blockers.push('Ingresso cancelado.');
  if (participant.checkin_status === 'done') blockers.push('Check-in já foi realizado para este ingresso.');
  if (!participant.can_operate && participant.block_reason) blockers.push(participant.block_reason);
  if (participant.shirt_stock?.status === 'out_of_stock') {
    blockers.push(
      `Camiseta ${participant.shirt_stock.shirt_type} ${participant.shirt_stock.shirt_size} sem estoque físico.`,
    );
  }
  for (const issue of participant.issues) {
    if (issue.blocks_checkin || issue.blocks_kit_delivery) blockers.push(issue.message);
  }
  return Array.from(new Set(blockers));
}

function displayName(participant: { full_name?: string | null; participant_name?: string | null }) {
  return (participant.full_name || participant.participant_name || 'Participante').trim();
}

function shirtLabel(participant: { shirt_type?: string | null; shirt_size?: string | null }) {
  if (!participant.shirt_type) return 'Camiseta não informada';
  return `${participant.shirt_type} ${participant.shirt_size ?? ''}`.trim();
}

function kitPending(participant: OperationTicketDetails) {
  if (!participant.event_kit_enabled && participant.kit_items.length === 0) return false;
  if (participant.all_kit_delivered) return false;
  return participant.kit_items.some((item) => item.status !== 'delivered') || participant.kit_status === 'pending' || participant.kit_status === 'partial';
}

function Chrome({ event, onExit, children }: { event: OperationEvent; onExit: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950 text-slate-100">
      <div className="mx-auto flex h-[100dvh] max-w-md flex-col px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="flex shrink-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-300">Modo Turbo</p>
            <h1 className="truncate text-base font-black leading-tight">{event.name}</h1>
          </div>
          <button
            type="button"
            onClick={onExit}
            className="min-h-11 shrink-0 rounded-2xl border border-slate-700 px-3 text-sm font-semibold"
          >
            Sair do Modo Turbo
          </button>
        </div>

        <div className="mt-3 flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

function BigButton({
  children,
  onClick,
  disabled,
  busy,
  tone = 'primary',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: 'primary' | 'neutral' | 'success' | 'danger';
}) {
  const toneClass =
    tone === 'primary'
      ? 'bg-cyan-500 text-cyan-950 shadow-lg shadow-cyan-500/20'
      : tone === 'success'
        ? 'bg-emerald-500 text-emerald-950 shadow-lg shadow-emerald-500/20'
        : tone === 'danger'
          ? 'border border-rose-500/50 bg-rose-500/15 text-rose-100'
          : 'border border-slate-700 text-slate-200';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`min-h-16 w-full rounded-3xl px-5 text-xl font-black disabled:cursor-not-allowed disabled:opacity-55 ${toneClass}`}
    >
      {busy ? (
        <span className="inline-flex items-center justify-center gap-3">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}

function StatusBanner({
  tone,
  label,
}: {
  tone: 'success' | 'attention' | 'block';
  label: string;
}) {
  const cls =
    tone === 'success'
      ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-100'
      : tone === 'attention'
        ? 'border-amber-400/50 bg-amber-500/15 text-amber-100'
        : 'border-rose-400/50 bg-rose-500/15 text-rose-100';
  const mark = tone === 'success' ? '✓' : tone === 'attention' ? '!' : '✕';
  return (
    <div className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-base font-black uppercase tracking-wide ${cls}`}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/20 text-2xl">{mark}</span>
      <span>{label}</span>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'attention' | 'neutral' }) {
  const valueClass =
    tone === 'success' ? 'text-emerald-200' : tone === 'attention' ? 'text-amber-200' : 'text-slate-50';
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-black leading-tight ${valueClass}`}>{value}</p>
    </div>
  );
}

export function TurboMode({ event, onExit }: { event: OperationEvent; onExit: (focusTicketId?: string) => void }) {
  const [screen, dispatch] = useReducer(reducer, { kind: 'scanning_initial' });
  const processingRef = useRef(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const returnTimerRef = useRef<number | null>(null);
  const [canUndoDelivery, setCanUndoDelivery] = useState(false);
  const [canDeliverStoreItems, setCanDeliverStoreItems] = useState(true);
  const [capabilities, setCapabilities] = useState<Pick<PickupCapabilities, 'canUndoKit' | 'canUndoCheckin' | 'canDeliverKit' | 'canCheckin' | 'canCombined'> | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getOperationCapabilitiesAction()
      .then((response) => {
        if (mounted && response.success) {
          setCanUndoDelivery(response.capabilities.canUndoDeliverStoreItems);
          setCanDeliverStoreItems(response.capabilities.canDeliverStoreItems);
          setCapabilities({
            canUndoKit: response.capabilities.canUndoKit,
            canUndoCheckin: response.capabilities.canUndoCheckin,
            canDeliverKit: response.capabilities.canDeliverKit,
            canCheckin: response.capabilities.canCheckin,
            canCombined: response.capabilities.canCombined,
          });
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    function sync() {
      setOffline(typeof navigator !== 'undefined' && !navigator.onLine);
    }
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  const scheduleReturn = useCallback(() => {
    if (returnTimerRef.current) window.clearTimeout(returnTimerRef.current);
    returnTimerRef.current = window.setTimeout(() => {
      dispatch({ type: 'RESET' });
    }, AUTO_RETURN_MS);
  }, []);

  const beginBusy = useCallback((label: string) => {
    processingRef.current = true;
    setBusyLabel(label);
  }, []);

  const endBusy = useCallback(() => {
    processingRef.current = false;
    setBusyLabel(null);
  }, []);

  const backToScanner = useCallback(() => {
    if (returnTimerRef.current) {
      window.clearTimeout(returnTimerRef.current);
      returnTimerRef.current = null;
    }
    processingRef.current = false;
    setBusyLabel(null);
    dispatch({ type: 'RESET' });
  }, []);

  const otherEventMessage = useCallback((name: string | null | undefined) => {
    return name ? `Este QR pertence a outro evento. ${name}.` : 'Este QR pertence a outro evento.';
  }, []);

  const openProduct = useCallback((item: OperationalProductItem) => {
    if (item.event_id && item.event_id !== event.id) {
      dispatch({
        type: 'SCAN_ERROR',
        title: 'Outro evento',
        message: otherEventMessage(item.event_name),
      });
      return;
    }
    if (item.delivery_status === 'delivered') {
      dispatch({ type: 'SCAN_PRODUCT_DELIVERED', item });
      return;
    }
    if (item.delivery_status === 'cancelled') {
      dispatch({ type: 'SCAN_ERROR', title: 'Pedido cancelado', message: 'O pedido deste item foi cancelado.' });
      return;
    }
    if (item.delivery_status === 'not_applicable') {
      dispatch({
        type: 'SCAN_ERROR',
        title: 'Pagamento pendente',
        message: 'Este pedido ainda não foi confirmado (pagamento pendente).',
      });
      return;
    }
    dispatch({ type: 'SCAN_PRODUCT', item });
  }, [event.id, otherEventMessage]);

  async function handleInitialScan(raw: string) {
    if (processingRef.current) return;
    if (isBrowserOffline()) {
      dispatch({ type: 'SCAN_ERROR', title: OFFLINE_COPY.title, message: OFFLINE_COPY.message });
      return;
    }
    processingRef.current = true;
    try {
      const result = await resolveTurboScanAction(raw);
      if (!result.success) {
        dispatch({ type: 'SCAN_ERROR', title: 'QR não reconhecido', message: result.message });
        return;
      }
      if (result.kind === 'ticket') {
        if (result.participant.event_id !== event.id) {
          dispatch({
            type: 'SCAN_ERROR',
            title: 'Outro evento',
            message: otherEventMessage(result.participant.event_name),
          });
          return;
        }
        dispatch({ type: 'SCAN_TICKET', participant: result.participant });
        return;
      }

      if (result.kind === 'product_choices') {
        const foreign = result.items.find((item) => item.event_id && item.event_id !== event.id);
        if (foreign && result.items.every((item) => item.event_id && item.event_id !== event.id)) {
          dispatch({
            type: 'SCAN_ERROR',
            title: 'Outro evento',
            message: otherEventMessage(foreign.event_name),
          });
          return;
        }
        dispatch({ type: 'SCAN_PRODUCT_CHOICES', items: result.items.filter((item) => !item.event_id || item.event_id === event.id) });
        return;
      }

      openProduct(result.item);
    } catch (error) {
      const caught = describeTurboCaughtError(error);
      dispatch({
        type: 'SCAN_ERROR',
        title: caught.title,
        message: caught.message,
      });
    } finally {
      processingRef.current = false;
    }
  }

  async function handleNext(participant: OperationTicketDetails) {
    if (processingRef.current) return;
    if (isBrowserOffline()) {
      dispatch({ type: 'FAIL', title: OFFLINE_COPY.title, message: OFFLINE_COPY.message, ticketId: participant.ticket_id });
      return;
    }
    const needsWristband = event.wristband_enabled && participant.wristband?.status !== 'active';
    if (needsWristband) {
      dispatch({ type: 'GO_TO_WRISTBAND' });
      return;
    }

    const nextLabel = kitPending(participant) ? 'ENTREGANDO...' : 'FAZENDO CHECK-IN...';
    beginBusy(nextLabel);
    try {
      const response = await deliverKitAndCheckinAction({ ticket_id: participant.ticket_id });
      if (!response.success) {
        dispatch({
          type: 'FAIL',
          title: getOperationalErrorTitle('code' in response ? response.code : undefined, response.message ?? ''),
          message: response.message ?? 'Não foi possível concluir a operação.',
          ticketId: participant.ticket_id,
        });
        return;
      }
      const extra = event.has_kit && response.kit_delivered ? 'Kit entregue com sucesso.' : null;
      dispatch({ type: 'TICKET_DONE', message: response.message ?? 'Check-in realizado.', extra, participant });
      scheduleReturn();
    } catch (error) {
      const caught = describeTurboCaughtError(error);
      dispatch({
        type: 'FAIL',
        title: caught.title,
        message: caught.message,
        ticketId: participant.ticket_id,
      });
    } finally {
      endBusy();
    }
  }

  async function handleWristbandScan(raw: string, participant: OperationTicketDetails) {
    if (processingRef.current) return;
    if (isBrowserOffline()) {
      dispatch({ type: 'FAIL', title: OFFLINE_COPY.title, message: OFFLINE_COPY.message, ticketId: participant.ticket_id, participant });
      return;
    }
    beginBusy('VINCULANDO PULSEIRA...');
    try {
      const response = await deliverKitCheckinAndLinkWristbandAction({
        ticket_id: participant.ticket_id,
        wristband_code: raw,
      });
      if (!response.success) {
        const holderName = 'holder_name' in response ? response.holder_name : null;
        const message = holderName
          ? `${response.message ?? 'Não foi possível concluir a operação.'} Titular: ${holderName}.`
          : response.message ?? 'Não foi possível concluir a operação.';
        dispatch({
          type: 'FAIL',
          title: getOperationalErrorTitle('code' in response ? response.code : undefined, response.message ?? ''),
          message,
          ticketId: participant.ticket_id,
          participant,
        });
        return;
      }
      const extra = event.has_kit ? 'Kit entregue com sucesso.' : null;
      dispatch({ type: 'TICKET_DONE', message: 'Pulseira vinculada e check-in realizado.', extra, participant });
      scheduleReturn();
    } catch (error) {
      const caught = describeTurboCaughtError(error);
      dispatch({
        type: 'FAIL',
        title: caught.title,
        message: caught.message,
        ticketId: participant.ticket_id,
        participant,
      });
    } finally {
      endBusy();
    }
  }

  // Entrega de produto -- QUALQUER canal, via o dispatcher unico
  // (deliverOperationalProductItemAction) que ja sabe, a partir de
  // item.source, qual RPC domain-specific chamar. Nenhum "if store/else
  // checkout" aqui.
  async function handleProductConfirm(item: OperationalProductItem) {
    if (!canDeliverStoreItems) return;
    if (processingRef.current) return;
    if (isBrowserOffline()) {
      dispatch({ type: 'FAIL', title: OFFLINE_COPY.title, message: OFFLINE_COPY.message, ticketId: null });
      return;
    }
    beginBusy('ENTREGANDO...');
    try {
      const response = await deliverOperationalProductItemAction({ source: item.source, item_id: item.item_id });
      if (!response.success) {
        dispatch({
          type: 'FAIL',
          title: getOperationalErrorTitle(undefined, response.message ?? ''),
          message: response.message ?? 'Não foi possível concluir a operação.',
          ticketId: null,
        });
        return;
      }
      dispatch({ type: 'PRODUCT_DONE', item });
      scheduleReturn();
    } catch (error) {
      const caught = describeTurboCaughtError(error);
      dispatch({
        type: 'FAIL',
        title: caught.title,
        message: caught.message,
        ticketId: null,
      });
    } finally {
      endBusy();
    }
  }

  return (
    <Chrome event={event} onExit={() => onExit()}>
      {offline ? (
        <div className="mb-3">
          <StatusBanner tone="block" label="Sem conexão" />
        </div>
      ) : null}

      {screen.kind === 'scanning_initial' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <QrScanner title="Aponte para o QR" onRead={handleInitialScan} square hideManual />
          <button
            type="button"
            onClick={() => dispatch({ type: 'OPEN_SEARCH' })}
            className="mt-4 min-h-14 w-full rounded-3xl border border-slate-600 bg-slate-900 text-lg font-bold text-slate-100"
          >
            Buscar participante
          </button>
        </div>
      ) : null}

      {screen.kind === 'searching' ? (
        <OperationSearch
          eventId={event.id}
          onSelectTicket={(participant) => dispatch({ type: 'SCAN_TICKET', participant })}
          onSelectProduct={openProduct}
          onCancel={backToScanner}
          onFail={(title, message) => dispatch({ type: 'SCAN_ERROR', title, message })}
        />
      ) : null}

      {screen.kind === 'ticket_review' ? (
        <TicketReview
          event={event}
          participant={screen.participant}
          canUndoKit={Boolean(capabilities?.canUndoKit)}
          canUndoCheckin={Boolean(capabilities?.canUndoCheckin)}
          canCompleteTicket={capabilities?.canCombined !== false}
          busy={Boolean(busyLabel)}
          busyLabel={busyLabel}
          onNext={() => void handleNext(screen.participant)}
          onCancel={backToScanner}
          onOpenAdmin={() => onExit(screen.participant.ticket_id)}
          onSelectRelated={(participant) => dispatch({ type: 'SCAN_TICKET', participant })}
        />
      ) : null}

      {screen.kind === 'scanning_wristband' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <StatusBanner tone="attention" label={busyLabel === 'VINCULANDO PULSEIRA...' ? 'VINCULANDO PULSEIRA...' : 'Pulseira necessária'} />
          <p className="text-center text-lg font-black leading-tight">{displayName(screen.participant)}</p>
          <p className="text-center text-sm text-slate-400">{shirtLabel(screen.participant)}</p>
          <div className={busyLabel ? 'pointer-events-none opacity-60' : undefined}>
            <QrScanner
              title="Escaneie a pulseira"
              onRead={(value) => handleWristbandScan(value, screen.participant)}
              onCancel={busyLabel ? undefined : backToScanner}
              square
              hideManual
              guideLabel="Aproxime a pulseira até o QR ocupar boa parte da área"
              helpMessage="Aproxime a pulseira da câmera e evite reflexos."
            />
          </div>
          {busyLabel ? (
            <p className="inline-flex items-center justify-center gap-2 text-sm font-semibold text-cyan-200">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
              {busyLabel}
            </p>
          ) : null}
        </div>
      ) : null}

      {screen.kind === 'ticket_success' ? (
        <SuccessStation
          title="Operação concluída"
          name={screen.participant ? displayName(screen.participant) : null}
          lines={[
            screen.participant ? shirtLabel(screen.participant) : null,
            screen.extra,
            screen.message,
          ]}
          onNext={backToScanner}
        />
      ) : null}

      {screen.kind === 'product_review' ? (
        <ProductReview
          item={screen.item}
          canDeliver={canDeliverStoreItems}
          busy={Boolean(busyLabel)}
          busyLabel={busyLabel}
          onConfirm={() => void handleProductConfirm(screen.item)}
          onCancel={backToScanner}
        />
      ) : null}

      {screen.kind === 'product_choices' ? (
        <ProductChoices items={screen.items} onSelect={openProduct} onCancel={backToScanner} />
      ) : null}

      {screen.kind === 'product_already_delivered' ? (
        <ProductAlreadyDelivered item={screen.item} canUndoDelivery={canUndoDelivery} onBack={backToScanner} onUndone={backToScanner} />
      ) : null}

      {screen.kind === 'product_success' ? (
        <SuccessStation
          title="Item entregue"
          name={screen.item?.product_name ?? null}
          lines={[
            screen.item?.variant ?? null,
            screen.item ? `Quantidade ${screen.item.quantity}` : null,
          ]}
          onNext={backToScanner}
        />
      ) : null}

      {screen.kind === 'error' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <StatusBanner tone={screen.tone === 'attention' ? 'attention' : 'block'} label={screen.title} />
          <p className="mt-4 text-base leading-snug text-slate-200">{screen.message}</p>
          <div className="mt-auto flex flex-col gap-2 pt-4">
            {screen.participant ? (
              <>
                <BigButton onClick={() => dispatch({ type: 'RETRY_WRISTBAND', participant: screen.participant as OperationTicketDetails })}>
                  Tentar outra pulseira
                </BigButton>
                <BigButton tone="neutral" onClick={backToScanner}>
                  VOLTAR AO SCANNER
                </BigButton>
              </>
            ) : (
              <BigButton onClick={backToScanner}>VOLTAR AO SCANNER</BigButton>
            )}
            {screen.ticketId ? (
              <details className="rounded-2xl border border-slate-800 px-3 py-2">
                <summary className="cursor-pointer text-sm font-semibold text-slate-500">Mais ações</summary>
                <button
                  type="button"
                  onClick={() => onExit(screen.ticketId ?? undefined)}
                  className="mt-2 min-h-12 w-full text-left text-sm text-slate-300"
                >
                  Abrir operação completa
                </button>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}
    </Chrome>
  );
}

function SuccessStation({
  title,
  name,
  lines,
  onNext,
}: {
  title: string;
  name: string | null;
  lines: Array<string | null | undefined>;
  onNext: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StatusBanner tone="success" label={title} />
      {name ? <p className="mt-5 text-3xl font-black leading-tight">{name}</p> : null}
      <div className="mt-3 space-y-2">
        {lines.filter(Boolean).map((line) => (
          <p key={line} className="text-lg font-semibold text-slate-200">
            {line}
          </p>
        ))}
      </div>
      <p className="mt-3 text-sm text-slate-500">Voltando ao leitor...</p>
      <div className="mt-auto pt-4">
        <BigButton tone="success" onClick={onNext}>
          LER PRÓXIMO QR
        </BigButton>
      </div>
    </div>
  );
}

function TicketReview({
  event,
  participant,
  canUndoKit,
  canUndoCheckin,
  canCompleteTicket,
  busy,
  busyLabel,
  onNext,
  onCancel,
  onOpenAdmin,
  onSelectRelated,
}: {
  event: OperationEvent;
  participant: OperationTicketDetails;
  canUndoKit: boolean;
  canUndoCheckin: boolean;
  canCompleteTicket: boolean;
  busy: boolean;
  busyLabel: string | null;
  onNext: () => void;
  onCancel: () => void;
  onOpenAdmin: () => void;
  onSelectRelated: (participant: OperationTicketDetails) => void;
}) {
  const blockers = getTicketBlockers(participant);
  const canProceed = blockers.length === 0;
  const alreadyUsed = participant.checkin_status === 'done';
  const needsWristband = event.wristband_enabled && participant.wristband?.status !== 'active';
  const pendingKit = kitPending(participant);
  const related = (participant.order_tickets ?? []).filter((ticket) => ticket.ticket_id !== participant.ticket_id);
  const [loadingRelatedId, setLoadingRelatedId] = useState<string | null>(null);
  const [undoKind, setUndoKind] = useState<'kit' | 'checkin' | null>(null);

  const banner = !canProceed
    ? alreadyUsed
      ? { tone: 'attention' as const, label: 'Ingresso já utilizado' }
      : { tone: 'block' as const, label: blockers[0] === 'Ingresso cancelado.' ? 'Ingresso cancelado' : 'Operação bloqueada' }
    : { tone: 'success' as const, label: 'QR identificado' };

  const remainingAction = canProceed
    ? remainingTurboTicketAction({
        ticketStatus: participant.ticket_status,
        checkinStatus: participant.checkin_status,
        canOperate: participant.can_operate,
        kitPending: pendingKit,
        wristbandRequired: needsWristband,
      })
    : null;
  const primaryLabel =
    remainingAction === 'wristband'
      ? 'ESCANEAR PULSEIRA'
      : remainingAction === 'deliver_and_checkin'
        ? 'ENTREGAR + CHECK-IN'
        : remainingAction === 'checkin'
          ? 'CHECK-IN'
          : 'VOLTAR AO SCANNER';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3">
        <StatusBanner tone={banner.tone} label={banner.label} />
        <p className="text-3xl font-black leading-none">{displayName(participant)}</p>
        <p className="text-base text-slate-400">{participant.category_name || 'Categoria não informada'}</p>

        <Fact label="Camiseta" value={shirtLabel(participant)} />
        <Fact
          label="Kit"
          value={pendingKit ? 'Kit pendente' : participant.event_kit_enabled || participant.kit_items.length > 0 ? 'Kit entregue' : 'Sem kit'}
          tone={pendingKit ? 'attention' : 'success'}
        />
        {event.wristband_enabled ? (
          <Fact
            label="Pulseira"
            value={participant.wristband?.status === 'active' ? participant.wristband.code : 'Necessária'}
            tone={participant.wristband?.status === 'active' ? 'success' : 'attention'}
          />
        ) : null}

        {blockers.length > 0 ? (
          <div className="space-y-1 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {blockers.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>
        ) : null}

        {related.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Outros ingressos desta compra</p>
            {related.map((ticket) => (
              <button
                key={ticket.ticket_id}
                type="button"
                disabled={busy || loadingRelatedId === ticket.ticket_id}
                onClick={async () => {
                  setLoadingRelatedId(ticket.ticket_id);
                  const result = await getOperationTicketDetailsAction(ticket.ticket_id);
                  setLoadingRelatedId(null);
                  if (result.success && result.participant && 'ticket_id' in result.participant && result.participant.ticket_id) {
                    onSelectRelated(result.participant as OperationTicketDetails);
                  }
                }}
                className="flex min-h-14 w-full items-center justify-between rounded-2xl border border-slate-700 bg-slate-900 px-4 text-left"
              >
                <span className="font-semibold">{ticket.participant_name}</span>
                <span className="text-sm text-slate-400">{ticket.shirt_type} {ticket.shirt_size}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="shrink-0 space-y-2 pt-2">
        {remainingAction && canCompleteTicket ? (
          <BigButton onClick={onNext} busy={busy} disabled={busy}>
            {busy ? busyLabel ?? 'PROCESSANDO...' : primaryLabel}
          </BigButton>
        ) : remainingAction && !canCompleteTicket ? (
          <>
            <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Ingresso identificado. Este perfil não entrega kit nem faz check-in. Use a Central ou um operador com permissão.
            </div>
            <BigButton onClick={onCancel}>VOLTAR AO SCANNER</BigButton>
          </>
        ) : (
          <BigButton onClick={onCancel}>VOLTAR AO SCANNER</BigButton>
        )}
        <details className="rounded-2xl border border-slate-800 px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-slate-500">Mais ações</summary>
          <div className="mt-2 flex flex-col gap-2">
            <button type="button" onClick={onCancel} disabled={busy} className="min-h-12 rounded-xl border border-slate-700 text-sm font-semibold disabled:opacity-40">
              Cancelar leitura
            </button>
            <button type="button" onClick={onOpenAdmin} disabled={busy} className="min-h-12 rounded-xl border border-slate-700 text-sm font-semibold disabled:opacity-40">
              Abrir operação completa
            </button>
            {canUndoKit && !pendingKit ? (
              <button type="button" onClick={() => setUndoKind('kit')} disabled={busy} className="min-h-12 rounded-xl border border-amber-700/60 text-sm font-semibold text-amber-200 disabled:opacity-40">
                Desfazer entrega
              </button>
            ) : null}
            {canUndoCheckin && alreadyUsed ? (
              <button type="button" onClick={() => setUndoKind('checkin')} disabled={busy} className="min-h-12 rounded-xl border border-amber-700/60 text-sm font-semibold text-amber-200 disabled:opacity-40">
                Desfazer check-in
              </button>
            ) : null}
          </div>
        </details>
      </div>

      {undoKind ? (
        <ReasonDialog
          title={undoKind === 'kit' ? 'Desfazer entrega do kit' : 'Desfazer check-in'}
          description="Ação administrativa. Exige motivo."
          submitLabel={undoKind === 'kit' ? 'Desfazer entrega' : 'Desfazer check-in'}
          extraOptionLabel={undoKind === 'checkin' ? 'Também desvincular a pulseira' : undefined}
          onSubmit={async ({ reasonCode, reasonText, extraOption }) => {
            const response =
              undoKind === 'kit'
                ? await undoFullKitDeliveryAction({ ticket_id: participant.ticket_id, reason_code: reasonCode, reason_text: reasonText })
                : await undoCheckinEntryAction({
                    ticket_id: participant.ticket_id,
                    reason_code: reasonCode,
                    reason_text: reasonText,
                    also_unlink_wristband: extraOption,
                  });
            if (!response.success) return { success: false, message: response.message };
            onCancel();
            return { success: true };
          }}
          onClose={() => setUndoKind(null)}
        />
      ) : null}
    </div>
  );
}

function OperationSearch({
  eventId,
  onSelectTicket,
  onSelectProduct,
  onCancel,
  onFail,
}: {
  eventId: string;
  onSelectTicket: (participant: OperationTicketDetails) => void;
  onSelectProduct: (item: OperationalProductItem) => void;
  onCancel: () => void;
  onFail: (title: string, message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [hits, setHits] = useState<TurboSearchHit[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function runSearch() {
    const search = query.trim();
    if (search.length < 2) {
      setMessage('Digite pelo menos 2 caracteres.');
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const result = await searchTurboOperationsAction({ eventId, search });
      if (!result.success) {
        onFail('Erro na busca', result.message ?? 'Não foi possível buscar.');
        return;
      }
      setHits(result.hits);
      if (result.hits.length === 0) setMessage('Nenhuma operação encontrada.');
    } catch (error) {
      const caught = describeTurboCaughtError(error);
      onFail(caught.title, caught.message);
    } finally {
      setLoading(false);
    }
  }

  async function pickTicket(row: OperationTicketRow) {
    if (!row.ticket_id) {
      onFail('Sem ingresso', 'Este cadastro não tem ingresso operacional.');
      return;
    }
    setLoading(true);
    try {
      const result = await getOperationTicketDetailsAction(row.ticket_id);
      if (!result.success || !result.participant || !('ticket_id' in result.participant) || !result.participant.ticket_id) {
        onFail('Ingresso não encontrado', result.success === false ? result.message ?? 'Falha ao abrir o ingresso.' : 'Falha ao abrir o ingresso.');
        return;
      }
      onSelectTicket(result.participant as OperationTicketDetails);
    } catch (error) {
      const caught = describeTurboCaughtError(error);
      onFail(caught.title, caught.message);
    } finally {
      setLoading(false);
    }
  }

  const tickets = hits.filter((hit) => hit.kind === 'ticket');
  const products = hits.filter((hit) => hit.kind === 'product');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="text-lg font-black">Buscar operação</p>
      <div className="mt-3 flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runSearch();
          }}
            placeholder="Nome, CPF, pedido ou código do ingresso"
          autoFocus
          className="min-h-14 min-w-0 flex-1 rounded-2xl border border-slate-700 bg-slate-900 px-4 text-lg"
        />
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={loading}
          className="min-h-14 rounded-2xl bg-cyan-500 px-4 font-black text-cyan-950 disabled:opacity-50"
        >
          Buscar
        </button>
      </div>
      <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto">
        {message ? <p className="text-sm text-slate-400">{message}</p> : null}
        {tickets.length > 0 ? (
          <div className="space-y-2">
            <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">Ingressos</p>
            {tickets.map((hit) => (
              <button
                key={hit.row.ticket_id ?? hit.row.participant_id}
                type="button"
                onClick={() => void pickTicket(hit.row)}
                disabled={loading}
                className="flex min-h-16 w-full flex-col items-start justify-center rounded-2xl border border-slate-700 bg-slate-900 px-4 text-left"
              >
                <span className="text-base font-black">{hit.row.full_name || hit.row.participant_name}</span>
                <span className="text-sm text-slate-400">
                  {hit.row.category_name} · {hit.row.kit_status === 'delivered' ? 'Kit entregue' : 'Kit pendente'}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {products.length > 0 ? (
          <div className="space-y-2">
            <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">Loja</p>
            {products.map((hit) => (
              <button
                key={`${hit.item.source}-${hit.item.item_id}`}
                type="button"
                onClick={() => onSelectProduct(hit.item)}
                disabled={loading}
                className="flex min-h-16 w-full flex-col items-start justify-center rounded-2xl border border-slate-700 bg-slate-900 px-4 text-left"
              >
                <span className="text-base font-black">{hit.item.person_name ?? hit.item.buyer}</span>
                <span className="text-sm text-slate-400">
                  Pedido {hit.item.order_reference} · {hit.item.variant ?? hit.item.product_name} · {hit.item.delivery_status === 'delivered' ? 'Já entregue' : 'Retirada pendente'}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <button type="button" onClick={onCancel} className="mt-3 min-h-12 w-full rounded-2xl border border-slate-700 font-semibold">
        Voltar ao scanner
      </button>
    </div>
  );
}

function ProductChoices({
  items,
  onSelect,
  onCancel,
}: {
  items: OperationalProductItem[];
  onSelect: (item: OperationalProductItem) => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StatusBanner tone="success" label="QR identificado" />
      <p className="mt-4 text-lg font-black">Itens deste pedido</p>
      <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
        {items.map((item) => (
          <button
            key={`${item.source}-${item.item_id}`}
            type="button"
            onClick={() => onSelect(item)}
            className="flex min-h-16 w-full flex-col items-start justify-center rounded-2xl border border-slate-700 bg-slate-900 px-4 text-left"
          >
            <span className="text-base font-black">{item.product_name}</span>
            <span className="text-sm text-slate-400">
              {item.variant ?? 'Sem variante'} · Qtd {item.quantity} · {item.delivery_status === 'delivered' ? 'Já entregue' : 'Retirada pendente'}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-auto pt-4">
        <BigButton onClick={onCancel}>VOLTAR AO SCANNER</BigButton>
      </div>
    </div>
  );
}

function ProductReview({
  item,
  canDeliver,
  busy,
  busyLabel,
  onConfirm,
  onCancel,
}: {
  item: OperationalProductItem;
  canDeliver: boolean;
  busy: boolean;
  busyLabel: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isUnit = item.source === 'store_unit' || item.source === 'checkout_unit';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StatusBanner tone="success" label="QR identificado" />
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{SOURCE_LABEL[item.source]}</p>
      <p className="mt-1 text-sm font-black uppercase tracking-wide text-cyan-200">Pedido {item.order_reference}</p>
      <p className="mt-3 text-3xl font-black leading-tight">{item.person_name ?? item.buyer}</p>
      <p className="mt-4 text-3xl font-black leading-tight">{item.product_name}</p>
      {item.variant ? <p className="mt-2 text-2xl font-black uppercase leading-tight text-slate-100">{item.variant}</p> : null}
      {isUnit && item.unit_index ? <p className="mt-2 text-base font-semibold text-cyan-300">Unidade {item.unit_index} de {item.quantity}</p> : null}
      <div className="mt-4 space-y-2">
        <Fact label="Quantidade" value={String(item.quantity)} />
        <Fact label="Retirada" value="Retirada pendente" tone="attention" />
      </div>
      {!canDeliver ? (
        <div className="mt-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Você não tem permissão para entregar itens da Loja.
        </div>
      ) : null}
      <div className="mt-auto flex flex-col gap-2 pt-4">
        {canDeliver ? (
          <BigButton onClick={onConfirm} busy={busy} disabled={busy}>
            {busy ? busyLabel ?? 'PROCESSANDO...' : 'ENTREGAR ITEM'}
          </BigButton>
        ) : (
          <BigButton onClick={onCancel}>VOLTAR AO SCANNER</BigButton>
        )}
      </div>
    </div>
  );
}

function ProductAlreadyDelivered({
  item,
  canUndoDelivery,
  onBack,
  onUndone,
}: {
  item: OperationalProductItem;
  canUndoDelivery: boolean;
  onBack: () => void;
  onUndone: () => void;
}) {
  const [showUndoReason, setShowUndoReason] = useState(false);
  const isUnit = item.source === 'store_unit' || item.source === 'checkout_unit';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StatusBanner tone="success" label={isUnit ? 'Unidade já entregue' : 'Item já entregue'} />
      <p className="mt-4 text-3xl font-black leading-tight">{item.product_name}</p>
      {item.variant ? <p className="mt-2 text-2xl font-black uppercase leading-tight">{item.variant}</p> : null}
      <div className="mt-4 space-y-2">
        <Fact label="Quantidade" value={String(item.quantity)} />
        {item.delivered_at ? (
          <Fact label="Entregue em" value={new Date(item.delivered_at).toLocaleString('pt-BR')} />
        ) : null}
      </div>
      <div className="mt-auto flex flex-col gap-2 pt-4">
        <BigButton onClick={onBack}>VOLTAR AO SCANNER</BigButton>
        {canUndoDelivery ? (
          <details className="rounded-2xl border border-slate-800 px-3 py-2">
            <summary className="cursor-pointer text-sm font-semibold text-slate-500">Mais ações</summary>
            <button type="button" onClick={() => setShowUndoReason(true)} className="mt-2 min-h-12 w-full rounded-xl border border-amber-700/60 text-sm font-semibold text-amber-200">
              Desfazer entrega
            </button>
          </details>
        ) : null}
      </div>

      {showUndoReason ? (
        <ReasonDialog
          title={isUnit ? 'Desfazer entrega da unidade' : 'Desfazer entrega do item'}
          description="O item volta ao estoque e passa a poder ser entregue novamente."
          submitLabel="Desfazer entrega"
          onSubmit={async ({ reasonCode, reasonText }) => {
            const response = await undoOperationalProductDeliveryAction({
              source: item.source,
              item_id: item.item_id,
              reason_code: reasonCode,
              reason_text: reasonText,
            });
            if (!response.success) {
              return { success: false, message: response.message ?? 'Não foi possível desfazer a entrega.' };
            }
            onUndone();
            return { success: true };
          }}
          onClose={() => setShowUndoReason(false)}
        />
      ) : null}
    </div>
  );
}
