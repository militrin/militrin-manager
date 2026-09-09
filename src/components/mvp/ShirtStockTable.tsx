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
import { Info } from "lucide-react";
import { resolveShirtStockAvailability } from "@/lib/inventory/availability";
import { ADMIN_LIST_ROW_CLASS, ADMIN_LIST_ZEBRA_CLASS, ADMIN_TABLE_ZEBRA_CLASS, adminTableRowProps } from "@/components/admin";

type ShirtStockRow = {
  id: string;
  shirt_type: string;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
};

type ShirtStockTableProps = {
  rows: ShirtStockRow[];
  eventId: string;
  eventName: string;
  shirtOrderDeadline: string | null;
  limitShirtSelectionToStock: boolean;
  canAdjustInventory: boolean;
  canViewHistory: boolean;
  canLimitSelection: boolean;
  canResetInventory: boolean;
  canClearHistory: boolean;
};

type BulkMode = "purchase" | "adjustment" | null;

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

function FreeReservationValue({ free, overbooked }: { free: number; overbooked: boolean }) {
  const freeLow = free > 0 && free <= 5;
  if (free === 0) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-rose-200">0</span>
        <span className="rounded-full border border-rose-500/35 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-200">
          Esgotado
        </span>
        {overbooked ? (
          <span
            className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-200"
            title="Reservas ativas excedem o estoque físico disponível."
          >
            Overbooking
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span className={freeLow ? "font-medium text-amber-200" : undefined}>
      {free}
      {freeLow ? (
        <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-amber-300/90">
          baixo
        </span>
      ) : null}
    </span>
  );
}

export function ShirtStockTable({
  rows,
  eventId,
  eventName,
  shirtOrderDeadline,
  limitShirtSelectionToStock,
  canAdjustInventory,
  canViewHistory,
  canLimitSelection,
  canResetInventory,
  canClearHistory,
}: ShirtStockTableProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isSavingLimit, startLimitTransition] = useTransition();
  const [isResetPending, startResetTransition] = useTransition();
  const [historyRowId, setHistoryRowId] = useState<string | null>(null);
  const [bulkMode, setBulkMode] = useState<BulkMode>(null);
  const [bulkQuantities, setBulkQuantities] = useState<Record<string, string>>({});
  const [bulkNotes, setBulkNotes] = useState<string>("");
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

  const totals = rows.reduce(
    (acc, row) => {
      const availability = resolveShirtStockAvailability({
        totalQuantity: row.total_quantity,
        reservedQuantity: row.reserved_quantity,
        deliveredQuantity: row.delivered_quantity,
      });
      return {
        total: acc.total + row.total_quantity,
        reserved: acc.reserved + row.reserved_quantity,
        delivered: acc.delivered + row.delivered_quantity,
        physical: acc.physical + availability.physicalAvailable,
        free: acc.free + availability.availableForReservation,
      };
    },
    { total: 0, reserved: 0, delivered: 0, physical: 0, free: 0 },
  );

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
    if (historyRowId === rowId) {
      setHistoryRowId(null);
      return;
    }

    setFeedback(null);
    setHistoryRowId(rowId);
    void loadHistory(rowId);
  }

  function openBulkMode(mode: Exclude<BulkMode, null>) {
    setFeedback(null);
    setHistoryRowId(null);
    setBulkQuantities({});
    setBulkNotes("");
    setBulkMode((current) => (current === mode ? null : mode));
  }

  function closeBulkMode() {
    setBulkMode(null);
    setBulkQuantities({});
    setBulkNotes("");
  }

  function updateBulkQuantity(rowId: string, value: string) {
    setBulkQuantities((previous) => ({ ...previous, [rowId]: value }));
  }

  function rowLabel(row: ShirtStockRow) {
    return `${row.shirt_type} ${row.shirt_size}`;
  }

  function submitBulk() {
    if (!bulkMode) return;
    setFeedback(null);

    const entries: Array<{ row: ShirtStockRow; quantity: number }> = [];
    for (const row of rows) {
      const raw = bulkQuantities[row.id];
      if (raw === undefined || raw.trim() === "") continue;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed)) {
        setFeedback({ type: "error", message: `Quantidade inválida para ${rowLabel(row)}.` });
        return;
      }
      if (bulkMode === "purchase" && parsed <= 0) {
        setFeedback({ type: "error", message: `A quantidade de ${rowLabel(row)} deve ser maior que zero.` });
        return;
      }
      if (bulkMode === "adjustment" && parsed === 0) continue;
      entries.push({ row, quantity: parsed });
    }

    if (entries.length === 0) {
      setFeedback({ type: "error", message: "Preencha ao menos uma quantidade." });
      return;
    }
    if (bulkMode === "adjustment" && bulkNotes.trim().length < 3) {
      setFeedback({ type: "error", message: "Informe o motivo do ajuste." });
      return;
    }

    startTransition(async () => {
      const results = await Promise.all(
        entries.map(async ({ row, quantity }) => {
          const payload = { event_id: eventId, inventory_id: row.id, quantity, notes: bulkNotes };
          const result = bulkMode === "purchase" ? await addInventoryQuantityAction(payload) : await adjustInventoryQuantityAction(payload);
          return { row, result };
        }),
      );

      const failures = results.filter(({ result }) => !result.success);

      if (failures.length === 0) {
        setFeedback({ type: "success", message: `${entries.length} tamanho(s) atualizado(s) com sucesso.` });
        closeBulkMode();
      } else {
        const succeededIds = new Set(results.filter(({ result }) => result.success).map(({ row }) => row.id));
        setBulkQuantities((previous) => {
          const next = { ...previous };
          for (const id of succeededIds) delete next[id];
          return next;
        });
        setFeedback({
          type: "error",
          message: `${results.length - failures.length} de ${results.length} salvos. Falhou: ${failures.map(({ row, result }) => `${rowLabel(row)} (${result.message})`).join("; ")}`,
        });
      }

      router.refresh();
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

      {canAdjustInventory ? <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => openBulkMode("purchase")}
          disabled={isPending}
          className={`rounded-xl border px-3 py-1.5 text-xs transition ${bulkMode === "purchase" ? "border-emerald-500 bg-emerald-500/10 text-emerald-200" : "border-emerald-800/80 text-emerald-300 hover:border-emerald-600"}`}
        >
          Adicionar encomenda
        </button>
        <button
          type="button"
          onClick={() => openBulkMode("adjustment")}
          disabled={isPending}
          className={`rounded-xl border px-3 py-1.5 text-xs transition ${bulkMode === "adjustment" ? "border-amber-500 bg-amber-500/10 text-amber-200" : "border-amber-800/80 text-amber-300 hover:border-amber-600"}`}
        >
          Ajustar estoque
        </button>
      </div> : null}

      {bulkMode ? (
        <div className="rounded-xl border border-slate-800/90 bg-slate-950/70 p-4">
          <p className="text-sm font-semibold text-slate-100">
            {bulkMode === "purchase" ? "Adicionar encomenda" : "Ajustar estoque"} — preencha os tamanhos recebidos/ajustados e confirme uma única vez
          </p>
          <label className="mt-3 block space-y-1 text-sm">
            <span className="text-slate-300">{bulkMode === "purchase" ? "Observação (opcional, aplicada a todos os tamanhos)" : "Motivo (obrigatório, aplicado a todos os tamanhos)"}</span>
            <input
              type="text"
              value={bulkNotes}
              onChange={(event) => setBulkNotes(event.target.value)}
              className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
              placeholder={bulkMode === "purchase" ? "Ex.: Encomenda de agosto" : "Ex.: Correção de contagem física"}
            />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={closeBulkMode} className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-300 transition hover:border-slate-500">
              Cancelar
            </button>
            <button
              type="button"
              onClick={submitBulk}
              disabled={isPending}
              className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isPending ? "Salvando..." : "Confirmar"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="hidden min-w-0 overflow-x-auto rounded-2xl border border-slate-800/80 md:block">
        <table className={`${ADMIN_TABLE_ZEBRA_CLASS} w-full text-sm`}>
          <thead className="bg-slate-950/70 text-left text-slate-400">
            <tr>
              <th className="px-2 py-2 font-medium">Modelo</th>
              <th className="px-2 py-2 font-medium">Tamanho</th>
              <th className="px-2 py-2 font-medium">Total</th>
              <th className="px-2 py-2 font-medium">Reservadas</th>
              <th className="px-2 py-2 font-medium">Entregues</th>
              <th className="min-w-[7.5rem] border-l border-slate-700/80 px-2 py-2 font-medium">
                <span className="inline-flex items-start gap-1 leading-tight">
                  <span>Disponível<br />físico</span>
                  <abbr title="Estoque total menos itens já entregues." className="mt-0.5 inline-flex cursor-help no-underline">
                    <Info className="inline size-3.5 text-slate-500" aria-label="Estoque total menos itens já entregues." />
                  </abbr>
                </span>
              </th>
              <th className="min-w-[7.5rem] px-2 py-2 font-medium">
                <span className="inline-flex items-start gap-1 leading-tight">
                  <span>Livre para<br />reserva</span>
                  <abbr title="Estoque físico disponível menos reservas ativas." className="mt-0.5 inline-flex cursor-help no-underline">
                    <Info className="inline size-3.5 text-slate-500" aria-label="Estoque físico disponível menos reservas ativas." />
                  </abbr>
                </span>
              </th>
              <th className="px-2 py-2 font-medium">
                {bulkMode === "purchase" ? "Quantidade recebida" : bulkMode === "adjustment" ? "Ajuste (+/-)" : "Histórico"}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 text-slate-200">
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-center text-slate-400" colSpan={8}>
                  Sem linhas de estoque neste evento.
                </td>
              </tr>
            ) : (
              rows.map((row, index) => {
                const historyItems = historyByRow[row.id] ?? [];
                const isHistoryOpen = historyRowId === row.id;
                const previousType = index > 0 ? rows[index - 1]?.shirt_type : null;
                const groupStart = Boolean(previousType && previousType !== row.shirt_type);
                const availability = resolveShirtStockAvailability({
                  totalQuantity: row.total_quantity,
                  reservedQuantity: row.reserved_quantity,
                  deliveredQuantity: row.delivered_quantity,
                });
                const free = availability.availableForReservation;

                return (
                  <Fragment key={row.id}>
                    <tr {...adminTableRowProps({ selected: isHistoryOpen, groupStart })}>
                      <td className="px-2 py-2">{row.shirt_type}</td>
                      <td className="px-2 py-2">{row.shirt_size}</td>
                      <td className="px-2 py-2">{row.total_quantity}</td>
                      <td className="px-2 py-2">{row.reserved_quantity}</td>
                      <td className="px-2 py-2">{row.delivered_quantity}</td>
                      <td className="border-l border-slate-700/80 px-2 py-2">
                        <span className="sr-only">Disponível físico: </span>
                        {availability.physicalAvailable}
                      </td>
                      <td className="px-2 py-2">
                        <span className="sr-only">Livre para reserva: </span>
                        <FreeReservationValue free={free} overbooked={availability.overbooked} />
                      </td>
                      <td className="px-2 py-2">
                        {bulkMode ? (
                          <input
                            type="number"
                            step={1}
                            value={bulkQuantities[row.id] ?? ""}
                            onChange={(event) => updateBulkQuantity(row.id, event.target.value)}
                            placeholder={bulkMode === "purchase" ? "0" : "+/-0"}
                            className="w-24 rounded-lg border border-slate-800 bg-slate-950/70 px-2 py-1 text-sm text-slate-100 outline-none"
                          />
                        ) : canViewHistory ? (
                          <button
                            type="button"
                            onClick={() => handleOpenHistory(row.id)}
                            disabled={historyLoadingRowId === row.id}
                            className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:border-slate-500"
                          >
                            {historyLoadingRowId === row.id ? "Carregando..." : isHistoryOpen ? "Fechar" : "Ver histórico"}
                          </button>
                        ) : (
                          <span className="text-xs text-slate-500">Somente leitura</span>
                        )}
                      </td>
                    </tr>

                    {isHistoryOpen ? (
                      <tr {...adminTableRowProps({ detail: true })}>
                        <td colSpan={8} className="bg-slate-950/40 px-3 py-3">
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
                                onClick={() => setHistoryRowId(null)}
                                className="rounded-xl border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500"
                              >
                                Fechar
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
          {rows.length > 0 ? (
            <tfoot className="bg-slate-950/90 text-slate-100">
              <tr>
                <td className="px-2 py-2 font-semibold" colSpan={2}>TOTAL</td>
                <td className="px-2 py-2 font-semibold">{totals.total}</td>
                <td className="px-2 py-2 font-semibold">{totals.reserved}</td>
                <td className="px-2 py-2 font-semibold">{totals.delivered}</td>
                <td className="border-l border-slate-700/80 px-2 py-2 font-semibold">{totals.physical}</td>
                <td className="px-2 py-2 font-semibold">{totals.free}</td>
                <td className="px-2 py-2" />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      <div className={`${ADMIN_LIST_ZEBRA_CLASS} space-y-2 md:hidden`}>
        {rows.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-700 py-8 text-center text-sm text-slate-400">
            Sem linhas de estoque neste evento.
          </div>
        ) : (
          rows.map((row, index) => {
            const historyItems = historyByRow[row.id] ?? [];
            const isHistoryOpen = historyRowId === row.id;
            const previousType = index > 0 ? rows[index - 1]?.shirt_type : null;
            const groupStart = Boolean(previousType && previousType !== row.shirt_type);
            const availability = resolveShirtStockAvailability({
              totalQuantity: row.total_quantity,
              reservedQuantity: row.reserved_quantity,
              deliveredQuantity: row.delivered_quantity,
            });
            return (
              <div
                key={row.id}
                className={`${ADMIN_LIST_ROW_CLASS} rounded-2xl border border-slate-800/80 px-3 py-3`}
                {...adminTableRowProps({ selected: isHistoryOpen, groupStart })}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-100">{row.shirt_type} {row.shirt_size}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      Total {row.total_quantity} · Reservadas {row.reserved_quantity} · Entregues {row.delivered_quantity}
                    </p>
                  </div>
                  {bulkMode ? (
                    <input
                      type="number"
                      step={1}
                      value={bulkQuantities[row.id] ?? ""}
                      onChange={(event) => updateBulkQuantity(row.id, event.target.value)}
                      placeholder={bulkMode === "purchase" ? "0" : "+/-0"}
                      className="w-24 rounded-lg border border-slate-800 bg-slate-950/70 px-2 py-1 text-sm text-slate-100 outline-none"
                    />
                  ) : canViewHistory ? (
                    <button
                      type="button"
                      onClick={() => handleOpenHistory(row.id)}
                      disabled={historyLoadingRowId === row.id}
                      className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 transition hover:border-slate-500"
                    >
                      {historyLoadingRowId === row.id ? "Carregando..." : isHistoryOpen ? "Fechar" : "Histórico"}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-500">Somente leitura</span>
                  )}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-xl border border-slate-800/80 bg-slate-950/40 px-3 py-2">
                    <dt className="text-[11px] uppercase tracking-wide text-slate-500">Disponível físico</dt>
                    <dd className="mt-0.5 font-medium text-slate-100">{availability.physicalAvailable}</dd>
                  </div>
                  <div className="rounded-xl border border-slate-800/80 bg-slate-950/40 px-3 py-2">
                    <dt className="text-[11px] uppercase tracking-wide text-slate-500">Livre para reserva</dt>
                    <dd className="mt-0.5">
                      <FreeReservationValue free={availability.availableForReservation} overbooked={availability.overbooked} />
                    </dd>
                  </div>
                </dl>
                {isHistoryOpen ? (
                  <div className="mt-3 rounded-xl border border-slate-800/90 bg-slate-950/70 p-3">
                    <p className="text-sm font-semibold text-slate-100">Histórico de movimentações</p>
                    <div className="mt-3 space-y-2">
                      {historyItems.length === 0 ? (
                        <p className="text-sm text-slate-400">Nenhuma movimentação registrada para esta combinação.</p>
                      ) : (
                        historyItems.map((item) => (
                          <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-200">
                            <p>{formatDateTimeBR(item.created_at, " às ")}</p>
                            <p>{formatMovementType(item.movement_type)} · {item.quantity > 0 ? `+${item.quantity}` : item.quantity}</p>
                            <p className="text-slate-300">{item.notes ?? "-"}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
        {rows.length > 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/80 px-3 py-3 text-sm text-slate-100">
            <p className="font-semibold">TOTAL</p>
            <p className="mt-1 text-xs text-slate-400">
              Total {totals.total} · Reservadas {totals.reserved} · Entregues {totals.delivered}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-2">
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-slate-500">Disponível físico</dt>
                <dd className="font-semibold">{totals.physical}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-slate-500">Livre para reserva</dt>
                <dd className="font-semibold">{totals.free}</dd>
              </div>
            </dl>
          </div>
        ) : null}
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
