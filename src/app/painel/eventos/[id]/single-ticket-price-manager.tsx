"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setEventSingleTicketPriceAction } from "@/app/eventos/actions";

type SingleTicketPriceManagerProps = {
  eventId: string;
  initialStatus: {
    male_price: number | null;
    female_price: number | null;
    price_confirmed: boolean;
    registration_enabled: boolean;
  };
};

function moneyInputToNumber(value: string) {
  const normalized = value.replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function SingleTicketPriceManager({ eventId, initialStatus }: SingleTicketPriceManagerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [malePriceInput, setMalePriceInput] = useState(initialStatus.male_price !== null ? String(initialStatus.male_price) : "");
  const [femalePriceInput, setFemalePriceInput] = useState(initialStatus.female_price !== null ? String(initialStatus.female_price) : "");
  const [priceConfirmed, setPriceConfirmed] = useState(initialStatus.price_confirmed);
  const formRef = useRef<HTMLDivElement | null>(null);

  const needsAttention = initialStatus.registration_enabled && !priceConfirmed;

  function focusForm() {
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function save() {
    setMessage(null);
    const malePrice = moneyInputToNumber(malePriceInput);
    const femalePrice = moneyInputToNumber(femalePriceInput);

    if (Number.isNaN(malePrice) || malePrice < 0) {
      setMessage({ type: "error", text: "Informe o preço masculino (pode ser 0 para ingresso gratuito)." });
      return;
    }
    if (Number.isNaN(femalePrice) || femalePrice < 0) {
      setMessage({ type: "error", text: "Informe o preço feminino (pode ser 0 para ingresso gratuito)." });
      return;
    }

    startTransition(async () => {
      const result = await setEventSingleTicketPriceAction({ event_id: eventId, male_price: malePrice, female_price: femalePrice });
      if (!result.success) {
        setMessage({ type: "error", text: result.message });
        return;
      }
      setPriceConfirmed(true);
      setMessage({ type: "success", text: "Preço configurado." });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {needsAttention ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
          <p className="font-semibold">Preço do ingresso ainda não configurado</p>
          <p className="mt-1 text-xs text-amber-200/80">As inscrições estão abertas, mas ninguém confirmou o preço do ingresso único deste evento.</p>
          <button
            type="button"
            onClick={focusForm}
            className="mt-3 rounded-lg border border-amber-400/40 px-3 py-1.5 text-xs text-amber-100"
          >
            Configurar agora
          </button>
        </div>
      ) : null}

      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
          {message.text}
        </div>
      ) : null}

      <div ref={formRef} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-100">Modelo de ingresso: Ingresso único</p>
        <p className="mt-1 text-xs text-slate-400">
          Este evento não tem categorias ativas, então existe um único tipo de ingresso. Defina o preço abaixo — não é
          necessário criar uma categoria só para isso.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs text-slate-300">Preço masculino</span>
            <input
              type="text"
              inputMode="decimal"
              value={malePriceInput}
              onChange={(event) => setMalePriceInput(event.target.value)}
              placeholder="0,00"
              className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-300">Preço feminino</span>
            <input
              type="text"
              inputMode="decimal"
              value={femalePriceInput}
              onChange={(event) => setFemalePriceInput(event.target.value)}
              placeholder="0,00"
              className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm"
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-500">Pode deixar 0,00 se este ingresso for realmente gratuito.</p>

        {priceConfirmed ? (
          <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
            Preço configurado
          </p>
        ) : null}

        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="mt-4 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60"
        >
          {isPending ? "Salvando..." : "Salvar preço do ingresso"}
        </button>
      </div>
    </div>
  );
}
