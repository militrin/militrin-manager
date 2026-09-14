'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { OperationEvent, OperationTicketDetails, OperationTicketRow, PickupCapabilities } from '../types';
import type { OperationalProductItem } from '@/lib/operations/operational-product-item';
import { SOURCE_LABEL } from '@/lib/operations/operational-product-item';
import {
  deliverKitAndCheckinAction,
  deliverKitCheckinAndLinkWristbandAction,
  deliverOperationalProductItemAction,
  getOperationCapabilitiesAction,
  getOperationTicketDetailsAction,
  listOperationTicketsAction,
  resolveTurboScanAction,
  undoCheckinEntryAction,
  undoFullKitDeliveryAction,
  undoOperationalProductDeliveryAction,
} from '../actions';
import { remainingTurboTicketAction } from '@/lib/operations/ticket-operation-gate';
import { getOperationalErrorTitle } from '../error-messages';
import { QrScanner } from './QrScanner';
import { ReasonDialog } from './ReasonDialog';

const AUTO_RETURN_MS = 1600;

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
  tone = 'primary',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
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
      disabled={disabled}
      className={`min-h-16 w-full rounded-3xl px-5 text-xl font-black disabled:cursor-not-allowed disabled:opacity-40 ${toneClass}`}
    >
      {children}
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
  const returnTimerRef = useRef<number | null>(null);
  const [canUndoDelivery, setCanUndoDelivery] = useState(false);
  const [capabilities, setCapabilities] = useState<Pick<PickupCapabilities, 'canUndoKit' | 'canUndoCheckin'> | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getOperationCapabilitiesAction()
      .then((response) => {
        if (mounted && response.success) {
          setCanUndoDelivery(response.capabilities.canUndoDeliverStoreItems);
          setCapabilities({
            canUndoKit: response.capabilities.canUndoKit,
            canUndoCheckin: response.capabilities.canUndoCheckin,
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

  const backToScanner = useCallback(() => {
    if (returnTimerRef.current) {
      window.clearTimeout(returnTimerRef.current);
      returnTimerRef.current = null;
    }
    processingRef.current = false;
    dispatch({ type: 'RESET' });
  }, []);

  async function handleInitialScan(raw: string) {
    if (processingRef.current) return;
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
            title: 'Evento diferente',
            message: 'Este ingresso pertence a outro evento. Selecione o evento correspondente para operar.',
          });
          return;
        }
        dispatch({ type: 'SCAN_TICKET', participant: result.participant });
        return;
      }

      // result.kind === 'product' -- QUALQUER canal (loja standalone ou
      // "compre junto", ja distinguido internamente por result.item.source).
      // Evento derivado do proprio item (resolvido no backend, nunca exigido
      // do cliente pra resolver o QR) -- so validado AQUI, contra o evento
      // ja selecionado, igual ao ingresso acima. event_id pode ser null
      // (produto global da loja, sem evento) -- nesse caso nunca bloqueia.
      if (result.item.event_id && result.item.event_id !== event.id) {
        dispatch({
          type: 'SCAN_ERROR',
          title: 'Evento diferente',
          message: 'Este produto pertence a outro evento. Selecione o evento correspondente para operar.',
        });
        return;
      }
      if (result.item.delivery_status === 'delivered') {
        // Segunda leitura (ou enesima): nunca um erro/toast que so some --
        // abre o resumo da entrega original, com botao explicito de volta.
        dispatch({ type: 'SCAN_PRODUCT_DELIVERED', item: result.item });
      } else if (result.item.delivery_status === 'cancelled') {
        dispatch({ type: 'SCAN_ERROR', title: 'Pedido cancelado', message: 'O pedido deste item foi cancelado.' });
      } else if (result.item.delivery_status === 'not_applicable') {
        dispatch({
          type: 'SCAN_ERROR',
          title: 'Pagamento pendente',
          message: 'Este pedido ainda não foi confirmado (pagamento pendente).',
        });
      } else {
        dispatch({ type: 'SCAN_PRODUCT', item: result.item });
      }
    } catch (error) {
      dispatch({
        type: 'SCAN_ERROR',
        title: 'Erro ao ler QR',
        message: error instanceof Error ? error.message : 'Falha inesperada ao consultar o QR Code.',
      });
    } finally {
      processingRef.current = false;
    }
  }

  async function handleNext(participant: OperationTicketDetails) {
    if (processingRef.current) return;
    const needsWristband = event.wristband_enabled && participant.wristband?.status !== 'active';
    if (needsWristband) {
      dispatch({ type: 'GO_TO_WRISTBAND' });
      return;
    }

    processingRef.current = true;
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
      dispatch({
        type: 'FAIL',
        title: 'Erro de rede',
        message: error instanceof Error ? error.message : 'Falha inesperada.',
        ticketId: participant.ticket_id,
      });
    } finally {
      processingRef.current = false;
    }
  }

  async function handleWristbandScan(raw: string, participant: OperationTicketDetails) {
    if (processingRef.current) return;
    processingRef.current = true;
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
      dispatch({
        type: 'FAIL',
        title: 'Erro de rede',
        message: error instanceof Error ? error.message : 'Falha inesperada.',
        ticketId: participant.ticket_id,
        participant,
      });
    } finally {
      processingRef.current = false;
    }
  }

  // Entrega de produto -- QUALQUER canal, via o dispatcher unico
  // (deliverOperationalProductItemAction) que ja sabe, a partir de
  // item.source, qual RPC domain-specific chamar. Nenhum "if store/else
  // checkout" aqui.
  async function handleProductConfirm(item: OperationalProductItem) {
    if (processingRef.current) return;
    processingRef.current = true;
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
      dispatch({
        type: 'FAIL',
        title: 'Erro de rede',
        message: error instanceof Error ? error.message : 'Falha inesperada.',
        ticketId: null,
      });
    } finally {
      processingRef.current = false;
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
        <ParticipantSearch
          eventId={event.id}
          onSelect={(participant) => dispatch({ type: 'SCAN_TICKET', participant })}
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
          onNext={() => void handleNext(screen.participant)}
          onCancel={backToScanner}
          onOpenAdmin={() => onExit(screen.participant.ticket_id)}
          onSelectRelated={(participant) => dispatch({ type: 'SCAN_TICKET', participant })}
        />
      ) : null}

      {screen.kind === 'scanning_wristband' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <StatusBanner tone="attention" label="Pulseira necessária" />
          <p className="text-center text-lg font-black leading-tight">{displayName(screen.participant)}</p>
          <p className="text-center text-sm text-slate-400">{shirtLabel(screen.participant)}</p>
          <QrScanner
            title="Escaneie a pulseira"
            onRead={(value) => handleWristbandScan(value, screen.participant)}
            onCancel={backToScanner}
            square
            hideManual
            guideLabel="Aproxime a pulseira até o QR ocupar boa parte da área"
            helpMessage="Aproxime a pulseira da câmera e evite reflexos."
          />
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
        <ProductReview item={screen.item} onConfirm={() => void handleProductConfirm(screen.item)} onCancel={backToScanner} />
      ) : null}

      {screen.kind === 'product_already_delivered' ? (
        <ProductAlreadyDelivered item={screen.item} canUndoDelivery={canUndoDelivery} onBack={backToScanner} onUndone={backToScanner} />
      ) : null}

      {screen.kind === 'product_success' ? (
        <SuccessStation
          title="Produto entregue"
          name={screen.item?.person_name ?? screen.item?.buyer ?? null}
          lines={[screen.item ? `${screen.item.quantity}× ${screen.item.product_name}` : 'Produto entregue com sucesso']}
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
  onNext,
  onCancel,
  onOpenAdmin,
  onSelectRelated,
}: {
  event: OperationEvent;
  participant: OperationTicketDetails;
  canUndoKit: boolean;
  canUndoCheckin: boolean;
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
                disabled={loadingRelatedId === ticket.ticket_id}
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
        {remainingAction ? (
          <BigButton onClick={onNext}>{primaryLabel}</BigButton>
        ) : (
          <BigButton onClick={onCancel}>VOLTAR AO SCANNER</BigButton>
        )}
        <details className="rounded-2xl border border-slate-800 px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-slate-500">Mais ações</summary>
          <div className="mt-2 flex flex-col gap-2">
            <button type="button" onClick={onCancel} className="min-h-12 rounded-xl border border-slate-700 text-sm font-semibold">
              Cancelar leitura
            </button>
            <button type="button" onClick={onOpenAdmin} className="min-h-12 rounded-xl border border-slate-700 text-sm font-semibold">
              Abrir operação completa
            </button>
            {canUndoKit && !pendingKit ? (
              <button type="button" onClick={() => setUndoKind('kit')} className="min-h-12 rounded-xl border border-amber-700/60 text-sm font-semibold text-amber-200">
                Desfazer entrega
              </button>
            ) : null}
            {canUndoCheckin && alreadyUsed ? (
              <button type="button" onClick={() => setUndoKind('checkin')} className="min-h-12 rounded-xl border border-amber-700/60 text-sm font-semibold text-amber-200">
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

function ParticipantSearch({
  eventId,
  onSelect,
  onCancel,
  onFail,
}: {
  eventId: string;
  onSelect: (participant: OperationTicketDetails) => void;
  onCancel: () => void;
  onFail: (title: string, message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<OperationTicketRow[]>([]);
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
      const result = await listOperationTicketsAction({ eventId, search, page: 1, pageSize: 40 });
      if (!result.success) {
        onFail('Erro na busca', result.message ?? 'Não foi possível buscar.');
        return;
      }
      setRows(result.tickets);
      if (result.tickets.length === 0) setMessage('Nenhum participante encontrado.');
    } catch (error) {
      onFail('Erro de rede', error instanceof Error ? error.message : 'Falha inesperada.');
    } finally {
      setLoading(false);
    }
  }

  async function pick(row: OperationTicketRow) {
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
      onSelect(result.participant as OperationTicketDetails);
    } catch (error) {
      onFail('Erro de rede', error instanceof Error ? error.message : 'Falha inesperada.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="text-lg font-black">Buscar participante</p>
      <div className="mt-3 flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runSearch();
          }}
          placeholder="Nome, CPF ou código"
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
      <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
        {message ? <p className="text-sm text-slate-400">{message}</p> : null}
        {rows.map((row) => (
          <button
            key={row.ticket_id ?? row.participant_id}
            type="button"
            onClick={() => void pick(row)}
            disabled={loading}
            className="flex min-h-16 w-full flex-col items-start justify-center rounded-2xl border border-slate-700 bg-slate-900 px-4 text-left"
          >
            <span className="text-base font-black">{row.full_name || row.participant_name}</span>
            <span className="text-sm text-slate-400">
              {row.category_name} · {row.shirt_type} {row.shirt_size}
            </span>
          </button>
        ))}
      </div>
      <button type="button" onClick={onCancel} className="mt-3 min-h-12 w-full rounded-2xl border border-slate-700 font-semibold">
        Voltar ao scanner
      </button>
    </div>
  );
}

// Revisao de produto -- QUALQUER canal (source distingue internamente, so
// pra badge/entrega -- a experiencia operacional e IDENTICA pros dois).
function ProductReview({
  item,
  onConfirm,
  onCancel,
}: {
  item: OperationalProductItem;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isUnit = item.source === 'store_unit' || item.source === 'checkout_unit';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StatusBanner tone="success" label="QR identificado" />
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{SOURCE_LABEL[item.source]}</p>
      <p className="mt-1 text-3xl font-black leading-tight">{isUnit ? item.product_name : `${item.quantity}x ${item.product_name}`}</p>
      <p className="mt-2 text-lg text-slate-300">{item.person_name ?? item.buyer}</p>
      {isUnit && item.unit_index ? <p className="text-base font-semibold text-cyan-300">Unidade {item.unit_index} de {item.quantity}</p> : null}
      {item.variant ? <p className="text-slate-400">{item.variant}</p> : null}
      <div className="mt-4 space-y-2">
        <Fact label="Pedido" value={item.order_reference} />
        <Fact label="Comprador" value={item.buyer} />
        <Fact label="Evento" value={item.event_name} />
      </div>
      <p className="mt-3 text-sm font-black uppercase tracking-wide text-amber-300">A entregar</p>
      <div className="mt-auto flex flex-col gap-2 pt-4">
        <BigButton onClick={onConfirm}>Confirmar entrega</BigButton>
        <details className="rounded-2xl border border-slate-800 px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-slate-500">Mais ações</summary>
          <button type="button" onClick={onCancel} className="mt-2 min-h-12 w-full rounded-xl border border-slate-700 text-sm font-semibold">
            Cancelar
          </button>
        </details>
      </div>
    </div>
  );
}

// Resumo da entrega -- aberto em QUALQUER leitura depois da primeira
// (2a, 3a, 10a...) do MESMO QR, pros dois canais. Nunca reprocessa entrega
// nem estoque (o backend ja e idempotente -- isto e so leitura); sempre
// mostra data/hora e operador da PRIMEIRA entrega (nunca do usuario atual).
// "Desfazer entrega" (motivo obrigatorio via ReasonDialog, mesmo padrao da
// Central normal) so aparece quando canUndoDelivery=true (permissao
// store.undo_delivery), verificado no componente pai via
// getOperationCapabilitiesAction.
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
      <StatusBanner tone="attention" label={isUnit ? 'Unidade já entregue' : 'Item já entregue'} />
      <p className="mt-4 text-3xl font-black leading-tight">{isUnit ? item.product_name : `${item.quantity}x ${item.product_name}`}</p>
      <p className="mt-2 text-lg text-slate-300">{item.person_name ?? item.buyer}</p>
      {isUnit && item.unit_index ? <p className="text-base font-semibold text-cyan-300">Unidade {item.unit_index} de {item.quantity}</p> : null}
      {item.variant ? <p className="text-slate-400">{item.variant}</p> : null}
      <div className="mt-4 space-y-2">
        <Fact label="Pessoa" value={item.person_name ?? item.buyer} />
        <Fact label="Pedido" value={item.order_reference} />
        <Fact label="Comprador" value={item.buyer} />
        <Fact label="Evento" value={item.event_name} />
        <Fact label="Primeira entrega" value={item.delivered_at ? new Date(item.delivered_at).toLocaleString('pt-BR') : '—'} />
        <Fact label="Operador" value={item.delivered_by ?? 'Não identificado'} />
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
