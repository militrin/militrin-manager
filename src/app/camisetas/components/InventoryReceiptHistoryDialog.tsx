"use client";

import { useEffect, useState } from "react";
import { listEventInventoryReceiptsAction, type InventoryReceiptRecord } from "@/app/camisetas/actions";
import { formatDateBR } from "@/lib/utils/date";

type InventoryReceiptHistoryDialogProps = {
  open: boolean;
  eventId: string;
  onClose: () => void;
};

export function InventoryReceiptHistoryDialog({
  open,
  eventId,
  onClose,
}: InventoryReceiptHistoryDialogProps) {
  const [loading, setLoading] = useState(false);
  const [receipts, setReceipts] = useState<InventoryReceiptRecord[]>([]);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      const result = await listEventInventoryReceiptsAction({ event_id: eventId });
      if (cancelled) return;
      setLoading(false);
      if (!result.success) {
        setLoadError(result.message);
        return;
      }
      setReceipts(result.receipts);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, eventId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4">
      <div className="max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 text-slate-100">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold">Histórico de entradas</h3>
            <p className="mt-1 text-sm text-slate-400">Encomendas e recebimentos deste evento. Sem reservas nem checkouts.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-700 px-3 py-1.5 text-xs text-slate-300"
          >
            Fechar
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {loading ? (
            <p className="text-sm text-slate-400">Carregando entradas...</p>
          ) : loadError ? (
            <p role="alert" className="rounded-xl border border-red-500/40 bg-red-500/15 px-3 py-2 text-sm text-red-100">
              {loadError}
            </p>
          ) : receipts.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhuma entrada registrada para este evento.</p>
          ) : (
            receipts.map((receipt) => {
              const expanded = Boolean(expandedIds[receipt.id]);
              return (
                <article key={receipt.id} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">{formatDateBR(receipt.received_at)}</p>
                  <h4 className="mt-1 text-base font-semibold text-slate-100">{receipt.description}</h4>
                  <p className="mt-1 text-sm text-slate-200">
                    <span className="font-semibold tabular-nums">{receipt.total_quantity}</span> peças
                  </p>
                  <dl className="mt-2 space-y-1 text-xs text-slate-400">
                    {receipt.ordered_at ? (
                      <div>
                        Pedido: {formatDateBR(receipt.ordered_at)}
                      </div>
                    ) : null}
                    <div>Recebimento: {formatDateBR(receipt.received_at)}</div>
                    <div>Registrado por: {receipt.operator_label}</div>
                    {receipt.supplier ? <div>Fornecedor: {receipt.supplier}</div> : null}
                    {receipt.notes ? <div>Obs.: {receipt.notes}</div> : null}
                  </dl>
                  <button
                    type="button"
                    onClick={() => setExpandedIds((previous) => ({ ...previous, [receipt.id]: !expanded }))}
                    className="mt-3 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200"
                  >
                    {expanded ? "Ocultar composição" : "Ver composição"}
                  </button>
                  {expanded ? (
                    <div className="mt-3 space-y-1 text-sm text-slate-200">
                      {receipt.items.map((item) => (
                        <div key={`${receipt.id}-${item.inventory_id}`} className="flex justify-between gap-3">
                          <span>
                            {item.shirt_type} {item.shirt_size}
                          </span>
                          <span className="tabular-nums">+{item.quantity}</span>
                        </div>
                      ))}
                      <div className="flex justify-between border-t border-slate-800 pt-2 font-semibold">
                        <span>Total</span>
                        <span className="tabular-nums">{receipt.total_quantity}</span>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
