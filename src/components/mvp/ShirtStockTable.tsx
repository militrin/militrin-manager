"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addInventoryQuantityAction,
  adjustInventoryQuantityAction,
  getInventoryMovementsAction,
  type InventoryMovementItem,
} from "@/app/camisetas/actions";

type ShirtStockRow = {
  id: string;
  event_name: string | null;
  shirt_type: string;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
  available: number;
};

type ShirtStockTableProps = {
  rows: ShirtStockRow[];
};

type PanelMode = "purchase" | "adjustment" | "history" | null;

function formatMovementType(type: string) {
  switch (type) {
    case "purchase":
      return "Compra";
    case "adjustment":
      return "Ajuste";
    case "return":
      return "Retorno";
    case "loss":
      return "Perda";
    default:
      return type;
  }
}

export function ShirtStockTable({ rows }: ShirtStockTableProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [quantity, setQuantity] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [historyByRow, setHistoryByRow] = useState<Record<string, InventoryMovementItem[]>>({});
  const [historyLoadingRowId, setHistoryLoadingRowId] = useState<string | null>(null);

  function closePanel() {
    setActiveRowId(null);
    setPanelMode(null);
    setQuantity("");
    setNotes("");
  }

  function openPanel(rowId: string, mode: Exclude<PanelMode, null>) {
    setFeedback(null);
    setActiveRowId(rowId);
    setPanelMode(mode);
    setQuantity("");
    setNotes("");
  }

  function parseQuantity(currentMode: Exclude<PanelMode, null>): { value: number } | { error: string } {
    const parsed = Number(quantity);
    if (!Number.isInteger(parsed)) {
      return { error: "A quantidade deve ser um número inteiro." };
    }

    if (currentMode === "purchase" && parsed <= 0) {
      return { error: "Para encomenda, a quantidade deve ser maior que zero." };
    }

    if (currentMode === "adjustment" && parsed === 0) {
      return { error: "Para ajuste, a quantidade deve ser diferente de zero." };
    }

    return { value: parsed };
  }

  async function loadHistory(rowId: string) {
    setHistoryLoadingRowId(rowId);
    const result = await getInventoryMovementsAction({ inventory_id: rowId });
    setHistoryLoadingRowId(null);

    if (!result.success) {
      setFeedback({ type: "error", message: result.message });
      return;
    }

    setHistoryByRow((previous) => ({
      ...previous,
      [rowId]: result.movements,
    }));
  }

  function handleOpenHistory(rowId: string) {
    if (activeRowId === rowId && panelMode === "history") {
      closePanel();
      return;
    }

    openPanel(rowId, "history");
    void loadHistory(rowId);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);

    if (!activeRowId || !panelMode || panelMode === "history") {
      return;
    }

    const parsedQuantity = parseQuantity(panelMode);
    if ("error" in parsedQuantity) {
      setFeedback({ type: "error", message: parsedQuantity.error });
      return;
    }

    startTransition(async () => {
      const payload = {
        inventory_id: activeRowId,
        quantity: parsedQuantity.value,
        notes,
      };

      const result =
        panelMode === "purchase"
          ? await addInventoryQuantityAction(payload)
          : await adjustInventoryQuantityAction(payload);

      setFeedback({ type: result.success ? "success" : "error", message: result.message });

      if (result.success) {
        closePanel();
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-4">
      {feedback ? (
        <div
          className={`rounded-xl border px-3 py-2 text-sm ${
            feedback.type === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/30 bg-red-500/10 text-red-200"
          }`}
        >
          {feedback.message}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-slate-800/80">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950/70 text-left text-slate-400">
            <tr>
              <th className="px-4 py-3 font-medium">Evento</th>
              <th className="px-4 py-3 font-medium">Modelo</th>
              <th className="px-4 py-3 font-medium">Tamanho</th>
              <th className="px-4 py-3 font-medium">Total recebido</th>
              <th className="px-4 py-3 font-medium">Reservadas</th>
              <th className="px-4 py-3 font-medium">Entregues</th>
              <th className="px-4 py-3 font-medium">Disponíveis</th>
              <th className="px-4 py-3 font-medium">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 bg-slate-900/60 text-slate-200">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-slate-400" colSpan={8}>
                  Sem linhas de estoque no evento ativo.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const historyItems = historyByRow[row.id] ?? [];
                const isActiveRow = activeRowId === row.id;

                return (
                  <>
                    <tr key={row.id}>
                      <td className="px-4 py-3">{row.event_name ?? "-"}</td>
                      <td className="px-4 py-3">{row.shirt_type}</td>
                      <td className="px-4 py-3">{row.shirt_size}</td>
                      <td className="px-4 py-3">{row.total_quantity}</td>
                      <td className="px-4 py-3">{row.reserved_quantity}</td>
                      <td className="px-4 py-3">{row.delivered_quantity}</td>
                      <td className="px-4 py-3">{row.available}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openPanel(row.id, "purchase")}
                            disabled={isPending}
                            className="rounded-xl border border-emerald-800/80 px-3 py-1.5 text-xs text-emerald-300 transition hover:border-emerald-600"
                          >
                            Adicionar encomenda
                          </button>
                          <button
                            type="button"
                            onClick={() => openPanel(row.id, "adjustment")}
                            disabled={isPending}
                            className="rounded-xl border border-amber-800/80 px-3 py-1.5 text-xs text-amber-300 transition hover:border-amber-600"
                          >
                            Ajustar estoque
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenHistory(row.id)}
                            disabled={isPending || historyLoadingRowId === row.id}
                            className="rounded-xl border border-slate-700 px-3 py-1.5 text-xs text-slate-200 transition hover:border-slate-500"
                          >
                            {historyLoadingRowId === row.id ? "Carregando..." : "Ver histórico"}
                          </button>
                        </div>
                      </td>
                    </tr>

                    {isActiveRow && panelMode === "history" ? (
                      <tr key={`${row.id}-history`}>
                        <td colSpan={8} className="bg-slate-950/40 px-4 py-4">
                          <div className="rounded-xl border border-slate-800/90 bg-slate-950/70 p-4">
                            <p className="text-sm font-semibold text-slate-100">Histórico de movimentações</p>
                            <div className="mt-3 space-y-2">
                              {historyItems.length === 0 ? (
                                <p className="text-sm text-slate-400">Nenhuma movimentação registrada para esta combinação.</p>
                              ) : (
                                historyItems.map((item) => (
                                  <div
                                    key={item.id}
                                    className="grid gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 md:grid-cols-4"
                                  >
                                    <span>{new Date(item.created_at).toLocaleString("pt-BR")}</span>
                                    <span>{formatMovementType(item.movement_type)}</span>
                                    <span>{item.quantity > 0 ? `+${item.quantity}` : item.quantity}</span>
                                    <span className="text-slate-300">{item.notes ?? "-"}</span>
                                  </div>
                                ))
                              )}
                            </div>
                            <div className="mt-4 flex justify-end">
                              <button
                                type="button"
                                onClick={closePanel}
                                className="rounded-xl border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500"
                              >
                                Fechar
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}

                    {isActiveRow && panelMode !== "history" && panelMode !== null ? (
                      <tr key={`${row.id}-${panelMode}`}>
                        <td colSpan={8} className="bg-slate-950/40 px-4 py-4">
                          <form onSubmit={handleSubmit} className="rounded-xl border border-slate-800/90 bg-slate-950/70 p-4">
                            <p className="text-sm font-semibold text-slate-100">
                              {panelMode === "purchase" ? "Adicionar encomenda" : "Ajustar estoque"}
                            </p>
                            <div className="mt-3 grid gap-3 md:grid-cols-2">
                              <label className="space-y-2 text-sm">
                                <span className="text-slate-300">
                                  {panelMode === "purchase" ? "Quantidade recebida" : "Quantidade de ajuste"}
                                </span>
                                <input
                                  type="number"
                                  step={1}
                                  value={quantity}
                                  onChange={(event) => setQuantity(event.target.value)}
                                  className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                                  placeholder={panelMode === "purchase" ? "Ex: 50" : "Ex: -3 ou 4"}
                                />
                              </label>

                              <label className="space-y-2 text-sm">
                                <span className="text-slate-300">Observação (opcional)</span>
                                <input
                                  type="text"
                                  value={notes}
                                  onChange={(event) => setNotes(event.target.value)}
                                  className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                                  placeholder="Primeira encomenda, Reposição julho, Lote fornecedor X"
                                />
                              </label>
                            </div>

                            <div className="mt-4 flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={closePanel}
                                className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 transition hover:border-slate-500"
                              >
                                Cancelar
                              </button>
                              <button
                                type="submit"
                                disabled={isPending}
                                className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-70"
                              >
                                {isPending ? "Salvando..." : panelMode === "purchase" ? "Adicionar" : "Aplicar ajuste"}
                              </button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    ) : null}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
