'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { issueTicketsForPaidOrderAction, type PaidOrderAwaitingIssue } from './actions';

function formatDateTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString('pt-BR');
}

function orderLabel(order: PaidOrderAwaitingIssue) {
  return order.display_number || order.order_number || order.order_id.slice(0, 8);
}

export function PaidOrdersAwaitingIssuePanel({
  orders,
  canIssue,
  selectedEventId,
}: {
  orders: PaidOrderAwaitingIssue[];
  canIssue: boolean;
  selectedEventId: string | null;
}) {
  const router = useRouter();
  const [issuingOrderId, setIssuingOrderId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const visible = useMemo(
    () => (selectedEventId ? orders.filter((order) => order.event_id === selectedEventId) : orders),
    [orders, selectedEventId],
  );

  function closeDialog() {
    setIssuingOrderId(null);
    setReason('');
    setError(null);
  }

  function submitIssue() {
    if (!issuingOrderId) return;
    const trimmed = reason.trim();
    if (trimmed.length < 8) {
      setError('Informe um motivo com pelo menos 8 caracteres.');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await issueTicketsForPaidOrderAction(issuingOrderId, trimmed);
      if (!result.success) {
        setError(result.message);
        return;
      }
      setSuccess(result.message);
      closeDialog();
      router.refresh();
    });
  }

  return (
    <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-amber-100">Pagamentos confirmados aguardando emissão</h2>
          <p className="mt-1 text-sm text-amber-200/80">
            O dinheiro já está registrado. Os ingressos deste pedido ainda não foram emitidos — em geral após pagamento tardio.
          </p>
        </div>
        <span className="rounded-full border border-amber-500/40 px-3 py-1 text-xs font-semibold text-amber-100">
          {visible.length} {visible.length === 1 ? 'pedido' : 'pedidos'}
        </span>
      </div>

      {success ? <p className="mt-3 text-sm text-emerald-300" role="status">{success}</p> : null}

      {visible.length === 0 ? (
        <p className="mt-4 text-sm text-slate-300">Nenhum pagamento confirmado aguardando emissão.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {visible.map((order) => (
            <li key={order.order_id} className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1 text-sm text-slate-200">
                  <p className="font-semibold text-slate-100">Pedido {orderLabel(order)}</p>
                  <p>Evento: {order.event_name}</p>
                  {order.buyer_name ? <p>Comprador: {order.buyer_name}</p> : null}
                  {order.holder_summary ? <p>Titular: {order.holder_summary}</p> : null}
                  <p>Status financeiro: pago</p>
                  <p>
                    Ingressos esperados: {order.expected_ticket_items} · faltando: {order.missing_ticket_items}
                  </p>
                  <p>Motivo da pendência: {order.pending_reason}</p>
                  <p>Pago em: {formatDateTime(order.paid_at)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/inscricoes/pedido/${order.order_id}`}
                    className="inline-flex h-10 items-center rounded-xl border border-slate-600 px-3 text-xs font-semibold text-slate-200"
                  >
                    Abrir pedido
                  </Link>
                  {canIssue ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSuccess(null);
                        setIssuingOrderId(order.order_id);
                        setReason('');
                        setError(null);
                      }}
                      className="inline-flex h-10 items-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 text-xs font-semibold text-emerald-200"
                    >
                      Emitir ingressos
                    </button>
                  ) : (
                    <p className="text-xs text-slate-400">Sem permissão para emitir. Peça a alguém com confirmação financeira.</p>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {issuingOrderId ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={closeDialog}>
          <div
            className="w-full max-w-md rounded-t-3xl border border-slate-700 bg-slate-950 p-5 sm:rounded-3xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-slate-100">Emitir ingressos deste pedido pago?</h3>
            <p className="mt-1 text-sm text-slate-400">
              Isso emite somente os ingressos faltantes. Produtos não geram ingresso. A ação é auditada.
            </p>
            <label className="mt-4 block space-y-1">
              <span className="text-xs text-slate-300">Motivo (obrigatório, mínimo 8 caracteres)</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              />
            </label>
            {error ? <p className="mt-2 text-sm text-rose-300" role="alert">{error}</p> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={submitIssue}
                className="inline-flex h-11 items-center rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-emerald-950 disabled:opacity-50"
              >
                {isPending ? 'Emitindo...' : 'Confirmar emissão'}
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={closeDialog}
                className="inline-flex h-11 items-center rounded-xl border border-slate-600 px-4 text-sm text-slate-200"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
