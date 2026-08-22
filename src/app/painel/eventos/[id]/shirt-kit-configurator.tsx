"use client";

import { useMemo, useState, useTransition } from "react";
import { saveEventShirtKitConfigurationAction } from "@/app/eventos/actions";
import { OFFICIAL_SHIRT_SIZE_ORDER, type ShirtType } from "@/lib/constants/shirts";

export type ShirtKitVariantRow = {
  variantId: string;
  shirtType: ShirtType;
  shirtSize: string;
  isActive: boolean;
  kitTotal: number;
  kitReserved: number;
  kitDelivered: number;
  stockTotal: number;
  stockReserved: number;
  stockDelivered: number;
};

export type ShirtKitConfiguratorInitial = {
  supplyMode: "stock" | "made_to_order" | "disabled";
  isRequired: boolean;
  quantityPerParticipant: number;
  variants: ShirtKitVariantRow[];
};

const SUPPLY_MODE_OPTIONS: Array<{ value: "stock" | "made_to_order" | "disabled"; label: string; description: string }> = [
  { value: "stock", label: "Controlado por estoque", description: "Só permite escolher tamanhos com saldo físico disponível." },
  { value: "made_to_order", label: "Sob encomenda", description: "Permite escolher qualquer tamanho habilitado, sem checar saldo físico." },
  { value: "disabled", label: "Desativado", description: "Camiseta não é oferecida neste evento." },
];

function hasMovement(row: ShirtKitVariantRow | undefined): boolean {
  if (!row) return false;
  return row.kitTotal > 0 || row.kitReserved > 0 || row.kitDelivered > 0 || row.stockTotal > 0 || row.stockReserved > 0 || row.stockDelivered > 0;
}

export function ShirtKitConfigurator({ eventId, initial }: { eventId: string; initial: ShirtKitConfiguratorInitial }) {
  const variantsByKey = useMemo(() => {
    const map = new Map<string, ShirtKitVariantRow>();
    for (const row of initial.variants) map.set(`${row.shirtType}::${row.shirtSize}`, row);
    return map;
  }, [initial.variants]);

  const initialActive = initial.variants.filter((row) => row.isActive);
  const [includeBabylook, setIncludeBabylook] = useState(initialActive.some((row) => row.shirtType === "Babylook"));
  const [selectedSizes, setSelectedSizes] = useState<{ Camiseta: Set<string>; Babylook: Set<string> }>(() => ({
    Camiseta: new Set(initialActive.filter((row) => row.shirtType === "Camiseta").map((row) => row.shirtSize)),
    Babylook: new Set(initialActive.filter((row) => row.shirtType === "Babylook").map((row) => row.shirtSize)),
  }));
  const [supplyMode, setSupplyMode] = useState(initial.supplyMode ?? "stock");
  const [isRequired, setIsRequired] = useState(initial.isRequired);
  const [quantity, setQuantity] = useState(String(initial.quantityPerParticipant || 1));
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [blockedRemovals, setBlockedRemovals] = useState<Array<{ shirt_type: string; shirt_size: string; reason: string }>>([]);

  const models: ShirtType[] = includeBabylook ? ["Camiseta", "Babylook"] : ["Camiseta"];

  const blockedInactive = initial.variants.filter((row) => !row.isActive && hasMovement(row));

  function toggleSize(model: ShirtType, size: string) {
    setSelectedSizes((prev) => {
      const next = { ...prev, [model]: new Set(prev[model]) };
      if (next[model].has(size)) next[model].delete(size);
      else next[model].add(size);
      return next;
    });
  }

  function save() {
    setMessage(null);
    const pairs: Array<{ shirt_type: ShirtType; shirt_size: string }> = [];
    for (const model of models) {
      for (const size of selectedSizes[model]) pairs.push({ shirt_type: model, shirt_size: size });
    }
    if (pairs.length === 0) {
      setMessage({ type: "error", text: "Selecione ao menos um tamanho." });
      return;
    }
    startTransition(async () => {
      const result = await saveEventShirtKitConfigurationAction({
        event_id: eventId,
        supply_mode: supplyMode,
        is_required: isRequired,
        quantity_per_participant: Number(quantity || 1),
        pairs: pairs as Array<{ shirt_type: "Camiseta" | "Babylook"; shirt_size: "PP" | "P" | "M" | "G" | "GG" | "EG" | "EXG" | "EXGG" }>,
      });
      if (!result.success) {
        setMessage({ type: "error", text: result.message });
        return;
      }
      setBlockedRemovals(result.blockedRemovals ?? []);
      setMessage({ type: "success", text: result.message });
    });
  }

  return (
    <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
      <div>
        <h3 className="font-semibold text-slate-100">Camiseta</h3>
        <p className="text-xs text-slate-500">Modelos e tamanhos disponíveis para este evento. Só os pares marcados abaixo existem como variante real — nenhum tamanho não selecionado é criado.</p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-300">Modelos disponíveis no evento</p>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
            <input type="radio" name="shirt-models" checked={!includeBabylook} onChange={() => setIncludeBabylook(false)} />
            <span>Somente Camiseta</span>
          </label>
          <label className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
            <input type="radio" name="shirt-models" checked={includeBabylook} onChange={() => setIncludeBabylook(true)} />
            <span>Camiseta + Babylook</span>
          </label>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-b border-slate-800 px-2 py-1.5 text-left text-slate-400">Tamanho</th>
              {models.map((model) => (
                <th key={model} className="border-b border-slate-800 px-2 py-1.5 text-center text-slate-400">{model}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {OFFICIAL_SHIRT_SIZE_ORDER.map((size) => (
              <tr key={size}>
                <td className="border-b border-slate-900 px-2 py-1.5 text-slate-300">{size}</td>
                {models.map((model) => {
                  const checked = selectedSizes[model].has(size);
                  const row = variantsByKey.get(`${model}::${size}`);
                  const willDeactivateInstead = !checked && hasMovement(row) && row?.isActive;
                  return (
                    <td key={model} className="border-b border-slate-900 px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSize(model, size)}
                        className="h-4 w-4 rounded border-slate-600"
                      />
                      {willDeactivateInstead ? (
                        <span className="mt-0.5 block text-[10px] leading-tight text-amber-400">tem movimentação</span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <label className="space-y-1">
          <span className="block text-xs text-slate-400">Modo de fornecimento</span>
          <select value={supplyMode} onChange={(event) => setSupplyMode(event.target.value as typeof supplyMode)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
            {SUPPLY_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <span className="block text-[11px] text-slate-500">{SUPPLY_MODE_OPTIONS.find((option) => option.value === supplyMode)?.description}</span>
        </label>

        <label className="space-y-1">
          <span className="block text-xs text-slate-400">Quantidade por participante</span>
          <input value={quantity} onChange={(event) => setQuantity(event.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
        </label>

        <label className="flex items-center gap-2 self-end pb-2">
          <input type="checkbox" checked={isRequired} onChange={(event) => setIsRequired(event.target.checked)} className="h-4 w-4 rounded border-slate-600" />
          <span className="text-xs text-slate-300">Obrigatório no ingresso</span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={pending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
          {pending ? "Salvando..." : "Salvar configuração de camiseta"}
        </button>
      </div>

      {message ? (
        <p className={`text-xs ${message.type === "success" ? "text-emerald-300" : "text-rose-300"}`}>{message.text}</p>
      ) : null}

      {blockedRemovals.length > 0 ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <p className="font-semibold">Alguns tamanhos não puderam ser removidos:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {blockedRemovals.map((item) => (
              <li key={`${item.shirt_type}-${item.shirt_size}`}>{item.shirt_type} {item.shirt_size}: {item.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {blockedInactive.length > 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-400">
          <p className="font-semibold text-slate-300">Tamanhos desativados com movimentação existente:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {blockedInactive.map((row) => (
              <li key={row.variantId}>
                {row.shirtType} {row.shirtSize} — estoque/pedidos/entregas vinculados. Marque a caixa acima para reabrir para novas vendas.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
