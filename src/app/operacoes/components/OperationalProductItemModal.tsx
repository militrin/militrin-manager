"use client";

import { useState, useTransition } from "react";
import type { OperationalProductItem } from "@/lib/operations/operational-product-item";
import { SOURCE_LABEL, deliveryStatusLabel } from "@/lib/operations/operational-product-item";
import { deliverOperationalProductItemAction, undoOperationalProductDeliveryAction } from "../actions";
import { ReasonDialog } from "./ReasonDialog";

// Modal aberto pelo scanner da Central de Operacoes quando o QR resolve pra
// um produto -- QUALQUER canal (loja standalone ou "compre junto",
// distinguido so por item.source). Tres modos visuais, todos no MESMO
// componente (nunca "if store / else checkout" espalhado):
//   - delivery_status='to_deliver' -> formulario de confirmar entrega;
//   - delivery_status='delivered' -> resumo da entrega (2a leitura em
//     diante -- nunca reprocessa, so mostra data/hora/operador da PRIMEIRA
//     entrega);
//   - qualquer outro -> so informa o motivo (pagamento pendente/cancelado),
//     sem acao disponivel.
export function OperationalProductItemModal({
  item,
  canUndoDelivery = false,
  onClose,
  onDelivered,
  onUndone,
}: {
  item: OperationalProductItem;
  canUndoDelivery?: boolean;
  onClose: () => void;
  onDelivered: () => void;
  onUndone?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [showUndoReason, setShowUndoReason] = useState(false);

  function handleConfirm() {
    setMessage(null);
    startTransition(async () => {
      const response = await deliverOperationalProductItemAction({ source: item.source, item_id: item.item_id });
      if (!response.success) {
        setMessage(response.message ?? "Não foi possível confirmar a entrega.");
        return;
      }
      onDelivered();
    });
  }

  const alreadyDelivered = item.delivery_status === "delivered";
  const canDeliver = item.delivery_status === "to_deliver";
  const status = deliveryStatusLabel(item.delivery_status);
  const isUnit = item.source === "store_unit" || item.source === "checkout_unit";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4">
      <div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">{SOURCE_LABEL[item.source]}</p>
          {alreadyDelivered ? <p className="text-xs font-bold uppercase tracking-wide text-cyan-300">{isUnit ? "Unidade já entregue" : "Item já entregue"}</p> : null}
        </div>
        <h2 className="mt-1 text-xl font-bold text-slate-100">
          {isUnit ? item.product_name : `${item.quantity}x ${item.product_name}`}
        </h2>
        {isUnit && item.unit_index ? (
          <p className="text-sm font-semibold text-cyan-300">Unidade {item.unit_index} de {item.quantity}</p>
        ) : null}
        {item.variant ? <p className="text-sm text-slate-400">{item.variant}</p> : null}

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-slate-500">Pedido</dt><dd className="text-slate-200">{item.order_reference}</dd></div>
          <div><dt className="text-xs text-slate-500">Comprador</dt><dd className="text-slate-200">{item.buyer}</dd></div>
          <div><dt className="text-xs text-slate-500">Evento</dt><dd className="text-slate-200">{item.event_name}</dd></div>
          <div><dt className="text-xs text-slate-500">Status</dt><dd className="text-slate-200">{status.label}</dd></div>
        </dl>

        {alreadyDelivered ? (
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">Primeira entrega</p>
            <p className="font-semibold text-slate-100">{item.delivered_at ? new Date(item.delivered_at).toLocaleString("pt-BR") : "—"}</p>
            <p className="mt-2 text-[11px] uppercase tracking-wide text-slate-500">Operador</p>
            <p className="font-semibold text-slate-100">{item.delivered_by ?? "Não identificado"}</p>
          </div>
        ) : null}

        {message ? <p className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{message}</p> : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200">
            {alreadyDelivered ? "Voltar ao leitor" : "Fechar"}
          </button>
          {canDeliver ? (
            <button
              type="button"
              onClick={handleConfirm}
              disabled={pending}
              className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-50"
            >
              {pending ? "Confirmando..." : "Confirmar entrega"}
            </button>
          ) : null}
          {alreadyDelivered && canUndoDelivery ? (
            <button
              type="button"
              onClick={() => setShowUndoReason(true)}
              className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm font-semibold text-rose-200"
            >
              Desfazer entrega
            </button>
          ) : null}
        </div>
      </div>

      {showUndoReason ? (
        <ReasonDialog
          title={isUnit ? "Desfazer entrega da unidade" : "Desfazer entrega do item"}
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
              return { success: false, message: response.message ?? "Não foi possível desfazer a entrega." };
            }
            onUndone?.();
            return { success: true };
          }}
          onClose={() => setShowUndoReason(false)}
        />
      ) : null}
    </div>
  );
}
