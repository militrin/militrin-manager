"use client";

import { useState, useTransition } from "react";
import { setEventTicketSaleModelAction } from "@/app/eventos/actions";

export function TicketSaleModelPicker({
  eventId,
  activeCategoryCount,
}: {
  eventId: string;
  activeCategoryCount: number;
}) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const persistedModel = activeCategoryCount === 0 ? "single" : "categories";
  const [intent, setIntent] = useState<"single" | "categories" | null>(null);
  const currentModel = intent ?? persistedModel;

  function selectModel(model: "single" | "categories") {
    if (isPending) return;
    if (model === "categories") {
      setIntent("categories");
      if (persistedModel === "categories") return;
      setMessage({ type: "success", text: "Crie ou ative uma categoria abaixo. Enquanto nenhuma estiver ativa, o checkout continua como ingresso único." });
      return;
    }

    if (persistedModel === "single") {
      setIntent(null);
      setMessage(null);
      return;
    }

    const confirmed = window.confirm(
      "Isso desativa todas as categorias deste evento e passa a vender ingresso único (um preço e um limite por lote). As categorias e os lotes por categoria continuam no histórico. Continuar?",
    );
    if (!confirmed) return;

    setMessage(null);
    startTransition(async () => {
      const result = await setEventTicketSaleModelAction({ event_id: eventId, model: "single" });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) setIntent(null);
    });
  }

  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <div>
        <p className="text-sm font-semibold text-slate-100">Modelo de ingresso</p>
        <p className="mt-0.5 text-xs text-slate-400">
          Masculino e Feminino não são categorias obrigatórias. Só existem se você criar categorias com esses nomes.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className={`flex cursor-pointer gap-3 rounded-xl border px-3 py-3 ${currentModel === "single" ? "border-emerald-500/50 bg-emerald-500/10" : "border-slate-800 bg-slate-900/40"}`}>
          <input
            type="radio"
            name={`ticket-sale-model-${eventId}`}
            checked={currentModel === "single"}
            disabled={isPending}
            onChange={() => selectModel("single")}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-slate-100">Ingresso único</span>
            <span className="mt-0.5 block text-xs text-slate-400">Um único ingresso e preço por lote.</span>
          </span>
        </label>
        <label className={`flex cursor-pointer gap-3 rounded-xl border px-3 py-3 ${currentModel === "categories" ? "border-emerald-500/50 bg-emerald-500/10" : "border-slate-800 bg-slate-900/40"}`}>
          <input
            type="radio"
            name={`ticket-sale-model-${eventId}`}
            checked={currentModel === "categories"}
            disabled={isPending}
            onChange={() => selectModel("categories")}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium text-slate-100">Por categorias</span>
            <span className="mt-0.5 block text-xs text-slate-400">Configure categorias e preços diferentes.</span>
          </span>
        </label>
      </div>

      {currentModel === "categories" && activeCategoryCount === 0 ? (
        <p className="text-xs text-amber-200">Crie ao menos uma categoria ativa para o comprador escolher o tipo de ingresso.</p>
      ) : null}

      {message ? (
        <p className={`text-sm ${message.type === "success" ? "text-emerald-200" : "text-rose-200"}`}>{message.text}</p>
      ) : null}
    </div>
  );
}
