"use client";

import { useState, useTransition } from "react";
import type { OrderItemProductDetails } from "../types";
import { deliverOrderItemProductAction } from "../actions";

const STATUS_LABEL: Record<OrderItemProductDetails["status"], string> = {
  reserved: "Pagamento pendente",
  confirmed: "A retirar",
  delivered: "Entregue",
  cancelled: "Pedido cancelado",
  expired: "Pedido expirado",
  refunded: "Pedido reembolsado",
  transferred: "Pedido transferido",
};

// Modal aberto pelo scanner da Central de Operacoes quando o QR resolve pra
// um produto "compre junto" (order_items.item_kind='product' -- dominio
// DIFERENTE de store_order_items, que ja tem sua propria tela em
// /minha-conta/compras/loja/... e no Modo Turbo). "Confirmar entrega" so
// aparece quando o item realmente pode ser entregue (status='confirmed');
// pagamento pendente/cancelado/ja entregue mostram so o motivo, sem botao.
export function OrderItemProductQrModal({
  item,
  onClose,
  onDelivered,
}: {
  item: OrderItemProductDetails;
  onClose: () => void;
  onDelivered: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const canDeliver = item.status === "confirmed";

  function handleConfirm() {
    setMessage(null);
    startTransition(async () => {
      const response = await deliverOrderItemProductAction(item.order_item_id);
      if (!response.success) {
        setMessage(response.message ?? "Não foi possível confirmar a entrega.");
        return;
      }
      onDelivered();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4">
      <div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">Produto "compre junto"</p>
        <h2 className="mt-1 text-xl font-bold text-slate-100">
          {item.quantity}x {item.store_item_name}
        </h2>
        {item.variant_label ? <p className="text-sm text-slate-400">{item.variant_label}</p> : null}

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-slate-500">Pedido</dt><dd className="text-slate-200">{item.order_number ?? "-"}</dd></div>
          <div><dt className="text-xs text-slate-500">Comprador</dt><dd className="text-slate-200">{item.buyer_name}</dd></div>
          <div><dt className="text-xs text-slate-500">Evento</dt><dd className="text-slate-200">{item.event_name}</dd></div>
          <div><dt className="text-xs text-slate-500">Status</dt><dd className="text-slate-200">{STATUS_LABEL[item.status]}</dd></div>
        </dl>

        {message ? <p className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{message}</p> : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200">
            Fechar
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
        </div>
      </div>
    </div>
  );
}
