"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { createInventoryReceiptAction } from "@/app/camisetas/actions";
import { OFFICIAL_SHIRT_SIZE_ORDER, SHIRT_TYPES } from "@/lib/constants/shirts";
import { dateTimePartsInEventTimeZone } from "@/lib/utils/date";

type ShirtStockRow = {
  id: string;
  shirt_type: string;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
};

type RegisterInventoryReceiptDialogProps = {
  open: boolean;
  eventId: string;
  rows: ShirtStockRow[];
  onClose: () => void;
  onSuccess: (message: string) => void;
};

function todayInEventTimeZone() {
  const parts = dateTimePartsInEventTimeZone(new Date());
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function RegisterInventoryReceiptDialog({
  open,
  eventId,
  rows,
  onClose,
  onSuccess,
}: RegisterInventoryReceiptDialogProps) {
  const [isPending, startTransition] = useTransition();
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [description, setDescription] = useState("");
  const [orderedAt, setOrderedAt] = useState("");
  const [receivedAt, setReceivedAt] = useState(todayInEventTimeZone);
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const sizesByType = useMemo(() => {
    return SHIRT_TYPES.map((type) => ({
      type,
      rows: rows.filter((row) => row.shirt_type === type),
    })).filter((group) => group.rows.length > 0);
  }, [rows]);

  const totalPieces = useMemo(() => {
    return rows.reduce((sum, row) => {
      const raw = quantities[row.id];
      if (!raw || raw.trim() === "") return sum;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) return sum;
      return sum + parsed;
    }, 0);
  }, [quantities, rows]);

  function resetFields() {
    setDescription("");
    setOrderedAt("");
    setReceivedAt(todayInEventTimeZone());
    setSupplier("");
    setNotes("");
    setQuantities({});
    setFormError(null);
  }

  function handleClose() {
    if (isPending) return;
    resetFields();
    onClose();
  }

  function submit() {
    const items: Array<{ inventory_id: string; quantity: number }> = [];
    for (const row of rows) {
      const raw = quantities[row.id];
      if (raw === undefined || raw.trim() === "") continue;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        setFormError(`Quantidade inválida para ${row.shirt_type} ${row.shirt_size}.`);
        return;
      }
      if (parsed === 0) continue;
      items.push({ inventory_id: row.id, quantity: parsed });
    }

    if (!description.trim()) {
      setFormError("A descrição é obrigatória.");
      return;
    }
    if (!receivedAt) {
      setFormError("A data de recebimento é obrigatória.");
      return;
    }
    const today = todayInEventTimeZone();
    if (receivedAt > today) {
      setFormError("Data de recebimento não pode ser futura.");
      return;
    }
    if (orderedAt && orderedAt > receivedAt) {
      setFormError("Data do pedido não pode ser posterior ao recebimento.");
      return;
    }
    if (items.length === 0) {
      setFormError("Informe ao menos uma quantidade maior que zero.");
      return;
    }

    setFormError(null);
    startTransition(async () => {
      try {
        const result = await createInventoryReceiptAction({
          event_id: eventId,
          idempotency_key: idempotencyKeyRef.current,
          description: description.trim(),
          received_at: receivedAt,
          ordered_at: orderedAt || undefined,
          supplier: supplier.trim() || undefined,
          notes: notes.trim() || undefined,
          items,
        });

        if (result.success) {
          idempotencyKeyRef.current = crypto.randomUUID();
          resetFields();
          onSuccess(result.message);
          onClose();
          return;
        }

        setFormError(result.message);
      } catch (error) {
        setFormError(error instanceof Error ? error.message : "Não foi possível registrar a entrada.");
      }
    });
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4">
      <div className="max-h-[92dvh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 text-slate-100">
        <h3 className="text-lg font-semibold">Registrar entrada</h3>
        <p className="mt-1 text-sm text-slate-400">
          Uma entrada atômica por encomenda/recebimento. Reservas e entregas não entram aqui.
        </p>
        {formError ? (
          <p role="alert" className="mt-3 rounded-xl border border-red-500/40 bg-red-500/15 px-3 py-2 text-sm text-red-100">
            {formError}
          </p>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm sm:col-span-2">
            <span className="text-slate-300">Descrição *</span>
            <input
              value={description}
              onChange={(event) => {
                setFormError(null);
                setDescription(event.target.value);
              }}
              placeholder="Ex.: Terceira encomenda"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Data do pedido</span>
              <input
                type="date"
                value={orderedAt}
                max={receivedAt || todayInEventTimeZone()}
                onChange={(event) => {
                  setFormError(null);
                  setOrderedAt(event.target.value);
                }}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Data de recebimento *</span>
              <input
                type="date"
                value={receivedAt}
                max={todayInEventTimeZone()}
                onChange={(event) => {
                  setFormError(null);
                  setReceivedAt(event.target.value);
                }}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Fornecedor</span>
            <input
              value={supplier}
              onChange={(event) => setSupplier(event.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Observação</span>
            <input
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="mt-5 overflow-x-auto rounded-2xl border border-slate-800">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="bg-slate-950/70 text-slate-400">
              <tr>
                <th className="px-2 py-2 text-left font-medium">Modelo</th>
                {OFFICIAL_SHIRT_SIZE_ORDER.map((size) => (
                  <th key={size} className="px-2 py-2 text-center font-medium">
                    {size}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sizesByType.map((group) => (
                <tr key={group.type} className="border-t border-slate-800">
                  <td className="px-2 py-2 font-medium text-slate-100">{group.type}</td>
                  {OFFICIAL_SHIRT_SIZE_ORDER.map((size) => {
                    const row = group.rows.find((item) => item.shirt_size === size);
                    if (!row) {
                      return (
                        <td key={size} className="px-2 py-2 text-center text-slate-700">
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={size} className="px-2 py-2">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          value={quantities[row.id] ?? ""}
                          onChange={(event) => {
                            setFormError(null);
                            setQuantities((previous) => ({ ...previous, [row.id]: event.target.value }));
                          }}
                          placeholder="0"
                          className="w-16 rounded-lg border border-slate-800 bg-slate-950/70 px-2 py-1 text-center text-sm text-slate-100 outline-none"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-sm text-slate-200">
          Total da entrada: <span className="font-semibold tabular-nums">{totalPieces}</span> peças
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={isPending}
            className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={isPending}
            className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-emerald-950 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isPending ? "Registrando..." : "Registrar entrada"}
          </button>
        </div>
      </div>
    </div>
  );
}
