'use client';

import { useCallback, useReducer, useRef } from 'react';
import type { OperationEvent, OperationTicketDetails, OrderItemProductDetails, TurboStoreItemDetails } from '../types';
import {
  deliverAdditionalStoreItemAction,
  deliverKitAndCheckinAction,
  deliverKitCheckinAndLinkWristbandAction,
  deliverOrderItemProductAction,
  resolveTurboScanAction,
} from '../actions';
import { getOperationalErrorTitle } from '../error-messages';
import { QrScanner } from './QrScanner';

const AUTO_RETURN_MS = 1600;

// Maquina de estados explicita (pedido: nunca vários booleans concorrentes
// que deixem a UI num estado impossível). Cada tela do Turbo corresponde a
// exatamente um "kind" aqui; a transição sempre passa pelo reducer abaixo.
type TurboScreen =
  | { kind: 'scanning_initial' }
  | { kind: 'ticket_review'; participant: OperationTicketDetails }
  | { kind: 'scanning_wristband'; participant: OperationTicketDetails }
  | { kind: 'ticket_success'; message: string; extra: string | null }
  | { kind: 'product_review'; item: TurboStoreItemDetails }
  // Produto "compre junto" (order_items) -- dominio DIFERENTE de
  // product_review acima (store_order_items). Tela propria, NUNCA
  // reaproveita ProductReview (que nao tem pedido/comprador/evento/status
  // de pagamento pra mostrar, e nunca deveria -- os dois dominios nao se
  // confundem nem na tela).
  | { kind: 'order_item_product_review'; item: OrderItemProductDetails }
  | { kind: 'product_success' }
  // participant presente so quando o erro veio da ETAPA de pulseira -- deixa
  // o operador tentar outra pulseira pro MESMO ingresso (sem re-escanear o
  // ingresso do zero) em vez de so poder cancelar tudo.
  | { kind: 'error'; title: string; message: string; ticketId: string | null; participant: OperationTicketDetails | null };

type TurboAction =
  | { type: 'SCAN_TICKET'; participant: OperationTicketDetails }
  | { type: 'SCAN_PRODUCT'; item: TurboStoreItemDetails }
  | { type: 'SCAN_ORDER_ITEM_PRODUCT'; item: OrderItemProductDetails }
  | { type: 'SCAN_ERROR'; title: string; message: string }
  | { type: 'GO_TO_WRISTBAND' }
  | { type: 'RETRY_WRISTBAND'; participant: OperationTicketDetails }
  | { type: 'TICKET_DONE'; message: string; extra: string | null }
  | { type: 'PRODUCT_DONE' }
  | { type: 'FAIL'; title: string; message: string; ticketId: string | null; participant?: OperationTicketDetails | null }
  | { type: 'RESET' };

function reducer(state: TurboScreen, action: TurboAction): TurboScreen {
  switch (action.type) {
    case 'SCAN_TICKET':
      return { kind: 'ticket_review', participant: action.participant };
    case 'SCAN_PRODUCT':
      return { kind: 'product_review', item: action.item };
    case 'SCAN_ORDER_ITEM_PRODUCT':
      return { kind: 'order_item_product_review', item: action.item };
    case 'SCAN_ERROR':
      return { kind: 'error', title: action.title, message: action.message, ticketId: null, participant: null };
    case 'GO_TO_WRISTBAND':
      return state.kind === 'ticket_review' ? { kind: 'scanning_wristband', participant: state.participant } : state;
    case 'RETRY_WRISTBAND':
      return { kind: 'scanning_wristband', participant: action.participant };
    case 'TICKET_DONE':
      return { kind: 'ticket_success', message: action.message, extra: action.extra };
    case 'PRODUCT_DONE':
      return { kind: 'product_success' };
    case 'FAIL':
      return { kind: 'error', title: action.title, message: action.message, ticketId: action.ticketId, participant: action.participant ?? null };
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

function Chrome({ event, onExit, children }: { event: OperationEvent; onExit: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col p-4 sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-cyan-300">Modo Turbo</p>
            <h1 className="text-2xl font-black sm:text-3xl">{event.name}</h1>
          </div>
          <button
            type="button"
            onClick={onExit}
            className="rounded-2xl border border-slate-700 px-5 py-3 text-sm font-semibold sm:text-base"
          >
            Sair do Modo Turbo
          </button>
        </div>

        <div className="mt-8 flex flex-1 flex-col">{children}</div>
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
  tone?: 'primary' | 'neutral';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        tone === 'primary'
          ? 'w-full rounded-3xl bg-cyan-500 px-6 py-6 text-2xl font-black text-cyan-950 shadow-lg shadow-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40'
          : 'w-full rounded-3xl border border-slate-700 px-6 py-5 text-lg font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-40'
      }
    >
      {children}
    </button>
  );
}

export function TurboMode({ event, onExit }: { event: OperationEvent; onExit: (focusTicketId?: string) => void }) {
  const [screen, dispatch] = useReducer(reducer, { kind: 'scanning_initial' });
  const processingRef = useRef(false);
  const returnTimerRef = useRef<number | null>(null);

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

      if (result.kind === 'store_item') {
        if (result.item.status === 'delivered') {
          dispatch({ type: 'SCAN_ERROR', title: 'Produto já entregue', message: 'Este item já foi entregue anteriormente.' });
        } else if (result.item.status === 'cancelled') {
          dispatch({ type: 'SCAN_ERROR', title: 'Pedido cancelado', message: 'O pedido deste item foi cancelado.' });
        } else if (result.item.status === 'reserved') {
          dispatch({
            type: 'SCAN_ERROR',
            title: 'Pagamento pendente',
            message: 'Este pedido ainda não foi confirmado (pagamento pendente).',
          });
        } else {
          dispatch({ type: 'SCAN_PRODUCT', item: result.item });
        }
        return;
      }

      // result.kind === 'order_item_product' -- dominio order_items (compre
      // junto), DIFERENTE do store_item acima (store_order_items). Evento
      // derivado do proprio item (event_id, ja resolvido no backend a
      // partir de order_item -> order -> event_id) -- so validado AQUI,
      // contra o evento ja selecionado, igual ao ingresso acima. Nunca
      // exigido do cliente pra resolver o QR.
      if (result.item.event_id !== event.id) {
        dispatch({
          type: 'SCAN_ERROR',
          title: 'Evento diferente',
          message: 'Este produto pertence a outro evento. Selecione o evento correspondente para operar.',
        });
        return;
      }
      if (result.item.status === 'delivered') {
        dispatch({ type: 'SCAN_ERROR', title: 'Produto já entregue', message: 'Este item já foi entregue anteriormente.' });
      } else if (result.item.status === 'reserved') {
        dispatch({
          type: 'SCAN_ERROR',
          title: 'Pagamento pendente',
          message: 'Este pedido ainda não foi confirmado (pagamento pendente).',
        });
      } else if (result.item.status !== 'confirmed') {
        dispatch({ type: 'SCAN_ERROR', title: 'Pedido cancelado', message: 'O pedido deste item foi cancelado.' });
      } else {
        dispatch({ type: 'SCAN_ORDER_ITEM_PRODUCT', item: result.item });
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
      dispatch({ type: 'TICKET_DONE', message: response.message ?? 'Check-in realizado.', extra });
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
      dispatch({ type: 'TICKET_DONE', message: 'Pulseira vinculada e check-in realizado.', extra });
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

  async function handleProductConfirm(item: TurboStoreItemDetails) {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      const response = await deliverAdditionalStoreItemAction(item.id);
      if (!response.success) {
        dispatch({
          type: 'FAIL',
          title: getOperationalErrorTitle(undefined, response.message ?? ''),
          message: response.message ?? 'Não foi possível concluir a operação.',
          ticketId: null,
        });
        return;
      }
      dispatch({ type: 'PRODUCT_DONE' });
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

  // Entrega de produto "compre junto" -- dominio DIFERENTE de
  // handleProductConfirm acima (store_order_items). Reusa PRODUCT_DONE (a
  // mensagem de sucesso ja e generica o bastante pros dois dominios).
  async function handleOrderItemProductConfirm(item: OrderItemProductDetails) {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      const response = await deliverOrderItemProductAction(item.order_item_id);
      if (!response.success) {
        dispatch({
          type: 'FAIL',
          title: getOperationalErrorTitle(undefined, response.message ?? ''),
          message: response.message ?? 'Não foi possível concluir a operação.',
          ticketId: null,
        });
        return;
      }
      dispatch({ type: 'PRODUCT_DONE' });
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
      {screen.kind === 'scanning_initial' ? (
        <div className="flex flex-1 flex-col justify-center gap-4">
          <p className="text-center text-lg text-slate-300">Escaneie o QR do ingresso ou de um produto da loja.</p>
          <QrScanner title="Leitor Turbo" onRead={handleInitialScan} />
        </div>
      ) : null}

      {screen.kind === 'ticket_review' ? (
        <TicketReview participant={screen.participant} onNext={() => void handleNext(screen.participant)} onCancel={backToScanner} />
      ) : null}

      {screen.kind === 'scanning_wristband' ? (
        <div className="flex flex-1 flex-col justify-center gap-4">
          <p className="text-center text-lg text-slate-300">Escaneie a pulseira de {screen.participant.full_name || screen.participant.participant_name}.</p>
          <QrScanner
            title="Escaneie a pulseira"
            onRead={(value) => handleWristbandScan(value, screen.participant)}
            onCancel={backToScanner}
            guideLabel="Aproxime a pulseira até o QR ocupar boa parte da área"
            helpMessage="Aproxime a pulseira da câmera e evite reflexos."
          />
        </div>
      ) : null}

      {screen.kind === 'ticket_success' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="text-6xl">✅</div>
          <p className="text-3xl font-black text-emerald-300">{screen.message}</p>
          {screen.extra ? <p className="text-lg text-slate-300">{screen.extra}</p> : null}
          <p className="mt-2 text-sm text-slate-500">Voltando ao leitor...</p>
        </div>
      ) : null}

      {screen.kind === 'product_review' ? (
        <ProductReview item={screen.item} onConfirm={() => void handleProductConfirm(screen.item)} onCancel={backToScanner} />
      ) : null}

      {screen.kind === 'order_item_product_review' ? (
        <OrderItemProductReview item={screen.item} onConfirm={() => void handleOrderItemProductConfirm(screen.item)} onCancel={backToScanner} />
      ) : null}

      {screen.kind === 'product_success' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="text-6xl">✅</div>
          <p className="text-3xl font-black text-emerald-300">Produto entregue com sucesso</p>
          <p className="mt-2 text-sm text-slate-500">Voltando ao leitor...</p>
        </div>
      ) : null}

      {screen.kind === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="text-6xl">⚠️</div>
          <p className="text-2xl font-black text-rose-300">{screen.title}</p>
          <p className="max-w-md text-base text-slate-300">{screen.message}</p>
          <div className="mt-4 flex w-full max-w-xs flex-col gap-2">
            {screen.participant ? (
              <>
                <BigButton onClick={() => dispatch({ type: 'RETRY_WRISTBAND', participant: screen.participant as OperationTicketDetails })}>
                  Tentar outra pulseira
                </BigButton>
                <BigButton tone="neutral" onClick={backToScanner}>
                  Cancelar e voltar ao leitor inicial
                </BigButton>
              </>
            ) : (
              <BigButton onClick={backToScanner}>Voltar ao leitor</BigButton>
            )}
            {screen.ticketId ? (
              <button
                type="button"
                onClick={() => onExit(screen.ticketId ?? undefined)}
                className="text-sm text-slate-400 underline"
              >
                Abrir operação completa
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Chrome>
  );
}

function TicketReview({
  participant,
  onNext,
  onCancel,
}: {
  participant: OperationTicketDetails;
  onNext: () => void;
  onCancel: () => void;
}) {
  const blockers = getTicketBlockers(participant);
  const canProceed = blockers.length === 0;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="rounded-3xl border border-slate-700 bg-slate-900 p-5">
        <p className="text-2xl font-black">{participant.full_name || participant.participant_name}</p>
        <p className="text-sm text-slate-400">{participant.category_name || 'Categoria não informada'}</p>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <InfoTile label="Status do ingresso" value={participant.ticket_status ?? '—'} />
          <InfoTile label="Check-in" value={participant.checkin_status === 'done' ? 'Realizado' : 'Pendente'} />
          <InfoTile label="Camiseta" value={participant.shirt_type ? `${participant.shirt_type} · ${participant.shirt_size}` : '—'} />
          <InfoTile label="Pulseira" value={participant.wristband?.status === 'active' ? participant.wristband.code : 'Sem pulseira'} />
        </div>

        {participant.kit_items.length > 0 ? (
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Itens do kit</p>
            <ul className="mt-1 space-y-1 text-sm">
              {participant.kit_items.map((item) => (
                <li key={item.kit_item_id} className="flex items-center justify-between rounded-lg border border-slate-800 px-3 py-1.5">
                  <span>{item.item_name}</span>
                  <span className={item.status === 'delivered' ? 'text-emerald-300' : 'text-amber-300'}>
                    {item.status === 'delivered' ? 'Entregue' : 'Pendente'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {blockers.length > 0 ? (
          <div className="mt-4 space-y-1 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
            {blockers.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <BigButton onClick={onNext} disabled={!canProceed}>
          Próximo
        </BigButton>
        <BigButton tone="neutral" onClick={onCancel}>
          Cancelar
        </BigButton>
      </div>
    </div>
  );
}

function ProductReview({
  item,
  onConfirm,
  onCancel,
}: {
  item: TurboStoreItemDetails;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-col items-center gap-3 rounded-3xl border border-slate-700 bg-slate-900 p-6 text-center">
        {item.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.image_url} alt={item.store_item_name} className="h-40 w-40 rounded-2xl object-cover" />
        ) : null}
        <p className="text-2xl font-black">{item.store_item_name}</p>
        {item.variant_label ? <p className="text-slate-400">{item.variant_label}</p> : null}
        <p className="text-lg text-slate-300">Quantidade: {item.quantity}</p>
        <p className="text-sm uppercase tracking-wide text-amber-300">A entregar</p>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <BigButton onClick={onConfirm}>Confirmar entrega</BigButton>
        <BigButton tone="neutral" onClick={onCancel}>
          Cancelar
        </BigButton>
      </div>
    </div>
  );
}

// Produto "compre junto" (order_items) -- dominio DIFERENTE de ProductReview
// acima (store_order_items). Mostra pedido/comprador/evento/status, exigido
// pelo fluxo operacional deste dominio (o outro nao precisa: item de loja
// solo ja chega ate aqui sempre pago, sem ambiguidade de evento).
function OrderItemProductReview({
  item,
  onConfirm,
  onCancel,
}: {
  item: OrderItemProductDetails;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-col items-center gap-3 rounded-3xl border border-slate-700 bg-slate-900 p-6 text-center">
        <p className="text-2xl font-black">{item.quantity}x {item.store_item_name}</p>
        {item.variant_label ? <p className="text-slate-400">{item.variant_label}</p> : null}

        <div className="mt-2 grid w-full grid-cols-2 gap-3 text-sm">
          <InfoTile label="Pedido" value={item.order_number ?? '-'} />
          <InfoTile label="Comprador" value={item.buyer_name} />
          <InfoTile label="Evento" value={item.event_name} />
          <InfoTile label="Pagamento" value="Pago" />
        </div>

        <p className="text-sm uppercase tracking-wide text-amber-300">A retirar</p>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <BigButton onClick={onConfirm}>Confirmar entrega</BigButton>
        <BigButton tone="neutral" onClick={onCancel}>
          Cancelar
        </BigButton>
      </div>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="font-semibold text-slate-100">{value}</p>
    </div>
  );
}
