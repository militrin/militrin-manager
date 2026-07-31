"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addInventoryQuantityAction,
  adjustInventoryQuantityAction,
  getInventoryMovementsAction,
  resetEventShirtInventoryAction,
  setEventShirtStockLimitAction,
  type InventoryMovementItem,
} from "@/app/camisetas/actions";
import { formatDateTimeBR } from "@/lib/utils/date";

type ShirtStockRow = {
  id: string;
  shirt_type: string;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
  available: number;
};

type ShirtStockTableProps = {
  rows: ShirtStockRow[];
  eventId: string;
  eventName: string;
  shirtOrderDeadline: string | null;
  limitShirtSelectionToStock: boolean;
  canLimitSelection: boolean;
  canResetInventory: boolean;
  canClearHistory: boolean;
};

type PanelMode = "purchase" | "adjustment" | "history" | null;

function formatMovementType(type: string) {
  switch (type) {
    case "purchase":
      return "Encomenda";
    case "adjustment":
      return "Ajuste";
    case "return":
      return "Devolução";
    case "loss":
      return "Perda";
    default:
      return type;
  }
}

export function ShirtStockTable({
  rows,
  eventId,
  eventName,
  shirtOrderDeadline,
  limitShirtSelectionToStock,
  canLimitSelection,
  canResetInventory,
  canClearHistory,
}: ShirtStockTableProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isSavingLimit, startLimitTransition] = useTransition();
  const [isResetPending, startResetTransition] = useTransition();
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [quantity, setQuantity] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [historyByRow, setHistoryByRow] = useState<Record<string, InventoryMovementItem[]>>({});
  const [historyLoadingRowId, setHistoryLoadingRowId] = useState<string | null>(null);
  const [nowMs] = useState<number>(() => Date.now());
  const [limitSelectionEnabled, setLimitSelectionEnabled] = useState<boolean>(limitShirtSelectionToStock);
  const [resetMode, setResetMode] = useState<"simple" | "full" | null>(null);
  const [resetReason, setResetReason] = useState<string>("");
  const [confirmEventName, setConfirmEventName] = useState<string>("");

  const deadlinePassed = (() => {
    if (!shirtOrderDeadline) return false;
    const ts = new Date(shirtOrderDeadline).getTime();
    if (Number.isNaN(ts)) return false;
    return nowMs > ts;
  })();

  function statusLabel() {
    return limitSelectionEnabled ? "Limitada ao estoque físico" : "Livre para encomenda";
  }

  function closeResetModal() {
    setResetMode(null);
    setResetReason("");
    setConfirmEventName("");
  }

  function toggleLimitSelection(nextValue: boolean) {
    if (!canLimitSelection) return;

    setFeedback(null);
    startLimitTransition(async () => {
      const result = await setEventShirtStockLimitAction({
        event_id: eventId,
        enabled: nextValue,
      });

      setFeedback({ type: result.success ? "success" : "error", message: result.message });
      if (result.success) {
        setLimitSelectionEnabled(nextValue);
        router.refresh();
      }
    });
  }

  function confirmReset() {
    if (!resetMode) return;

    setFeedback(null);
    startResetTransition(async () => {
      const result = await resetEventShirtInventoryAction({
        event_id: eventId,
        clear_history: resetMode === "full",
        reason: resetReason,
        event_name_confirmation: confirmEventName,
      });

      setFeedback({ type: result.success ? "success" : "error", message: result.message });
      if (result.success) {
        closeResetModal();
        router.refresh();
      }
    });
  }

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

    if (currentMode === "adjustment" && notes.trim().length < 3) {
      return { error: "Informe o motivo do ajuste." };
    }

    return { value: parsed };
  }

  async function loadHistory(rowId: string) {
    setHistoryLoadingRowId(rowId);
    const result = await getInventoryMovementsAction({ inventory_id: rowId, event_id: eventId });
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
        event_id: eventId,
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

      <section className="rounded-2xl border border-slate-800/80 bg-slate-950/50 p-4">
        <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Evento: {eventName}</p>
        <p className="mt-2 text-sm text-slate-300">
          Status da escolha: <span className="font-semibold text-slate-100">{statusLabel()}</span>
        </p>

        <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm text-slate-300">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={limitSelectionEnabled}
              disabled={!canLimitSelection || isSavingLimit}
              onChange={(event) => toggleLimitSelection(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              Limitar escolha aos tamanhos disponíveis em estoque
              <span className="mt-1 block text-xs text-slate-400">
                Quando ativado, participantes só poderão escolher modelos e tamanhos com saldo disponível. Quando desativado, todas as variantes cadastradas permanecem disponíveis para encomenda.
              </span>
            </span>
          </label>
        </div>

        {deadlinePassed && !limitSelectionEnabled ? (
          <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
            A data-limite para pedido de camiseta já passou e a limitação por estoque ainda está desligada.
            {canLimitSelection ? (
              <button
                type="button"
                onClick={() => toggleLimitSelection(true)}
                disabled={isSavingLimit}
                className="ml-3 rounded-lg border border-amber-400/50 px-3 py-1 text-xs text-amber-100 disabled:opacity-60"
              >
                Ativar limitação agora
              </button>
            ) : null}
          </div>
        ) : null}

        {(canLimitSelection || canResetInventory || canClearHistory) ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {canLimitSelection ? (
              <>
                <button
                  type="button"
                  onClick={() => toggleLimitSelection(true)}
                  disabled={isSavingLimit || limitSelectionEnabled}
                  className="rounded-xl border border-slate-700 px-3 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                >
                  Ativar limitação
                </button>
                <button
                  type="button"
                  onClick={() => toggleLimitSelection(false)}
                  disabled={isSavingLimit || !limitSelectionEnabled}
                  className="rounded-xl border border-slate-700 px-3 py-1.5 text-xs text-slate-200 disabled:opacity-50"
                >
                  Desativar limitação
                </button>
              </>
            ) : null}

            {canResetInventory ? (
              <button
                type="button"
                onClick={() => setResetMode("simple")}
                disabled={isResetPending}
                className="rounded-xl border border-amber-600/60 px-3 py-1.5 text-xs text-amber-200 disabled:opacity-50"
              >
                Zerar estoque
              </button>
            ) : null}

            {canClearHistory ? (
              <button
                type="button"
                onClick={() => setResetMode("full")}
                disabled={isResetPending}
                className="rounded-xl border border-red-600/60 px-3 py-1.5 text-xs text-red-200 disabled:opacity-50"
              >
                Zerar estoque e limpar histórico
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <div className="overflow-hidden rounded-2xl border border-slate-800/80">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950/70 text-left text-slate-400">
            <tr>
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
                <td className="px-4 py-6 text-center text-slate-400" colSpan={7}>
                  Sem linhas de estoque neste evento.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const historyItems = historyByRow[row.id] ?? [];
                const isActiveRow = activeRowId === row.id;

                return (
                  <Fragment key={row.id}>
                    <tr>
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
                      <tr>
                        <td colSpan={7} className="bg-slate-950/40 px-4 py-4">
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
                                    <span>{formatDateTimeBR(item.created_at, " às ")}</span>
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
                      <tr>
                        <td colSpan={7} className="bg-slate-950/40 px-4 py-4">
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
                                <span className="text-slate-300">{panelMode === "purchase" ? "Observação (opcional)" : "Motivo"}</span>
                                {panelMode === "adjustment" ? (
                                  <span className="block text-xs text-slate-400">Motivo obrigatório para ajustes.</span>
                                ) : null}
                                <input
                                  type="text"
                                  value={notes}
                                  onChange={(event) => setNotes(event.target.value)}
                                  className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                                  placeholder={
                                    panelMode === "purchase"
                                      ? "Primeira encomenda, Segunda encomenda, Reposição de agosto"
                                      : "+5 correção de contagem, -2 camisetas com defeito"
                                  }
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
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {resetMode ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/70 px-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-5 text-slate-100">
            <h3 className="text-lg font-semibold">Zerar estoque deste evento?</h3>
            <p className="mt-2 text-sm text-slate-300">
              Esta ação zerará todas as quantidades de camisetas e babylooks do evento selecionado e {resetMode === "full" ? "removerá o histórico de movimentações de estoque" : "preservará o histórico de movimentações"}. Pedidos, participantes, tickets e pagamentos não serão apagados.
            </p>

            {resetMode === "full" ? (
              <p className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                Modo de risco: limpeza completa de histórico. Use somente para ambiente de teste/homologação.
              </p>
            ) : (
              <p className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                Modo recomendado: apenas zerar quantidades operacionais e preservar histórico.
              </p>
            )}

            <div className="mt-4 grid gap-3">
              <label className="space-y-1 text-sm">
                <span className="text-slate-300">Digite exatamente o nome do evento para confirmar</span>
                <input
                  value={confirmEventName}
                  onChange={(event) => setConfirmEventName(event.target.value)}
                  placeholder={eventName}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                />
              </label>

              <label className="space-y-1 text-sm">
                <span className="text-slate-300">Motivo da ação</span>
                <textarea
                  value={resetReason}
                  onChange={(event) => setResetReason(event.target.value)}
                  rows={3}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  placeholder="Ex.: Reset de ambiente de homologação antes de novo ciclo de testes"
                />
              </label>
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={closeResetModal}
                className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmReset}
                disabled={isResetPending || confirmEventName.trim() !== eventName || resetReason.trim().length < 3}
                className="rounded-xl bg-red-500 px-3 py-2 text-xs font-semibold text-red-950 disabled:opacity-50"
              >
                {isResetPending ? "Processando..." : "Confirmar zeragem"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
