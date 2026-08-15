"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { upsertEventPaymentMethodsAction } from "@/app/eventos/actions";

type EventPaymentMethodsManagerProps = {
  eventId: string;
  initialConfig: {
    pix_enabled: boolean;
    credit_card_single_enabled: boolean;
    credit_card_installments_enabled: boolean;
  };
};

export function EventPaymentMethodsManager({ eventId, initialConfig }: EventPaymentMethodsManagerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [form, setForm] = useState(initialConfig);

  function save() {
    setMessage(null);

    if (!form.pix_enabled && !form.credit_card_single_enabled && !form.credit_card_installments_enabled) {
      setMessage({ type: "error", text: "Selecione pelo menos uma forma de pagamento." });
      return;
    }

    startTransition(async () => {
      const result = await upsertEventPaymentMethodsAction({
        event_id: eventId,
        pix_enabled: form.pix_enabled,
        credit_card_single_enabled: form.credit_card_single_enabled,
        credit_card_installments_enabled: form.credit_card_installments_enabled,
      });

      if (!result.success) {
        setMessage({ type: "error", text: result.message });
        return;
      }

      router.push(`/painel/eventos/${eventId}?etapa=6`);
    });
  }

  return (
    <div className="space-y-4">
      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
          {message.text}
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-100">Formas aceitas neste evento</p>
        <p className="mt-1 text-xs text-slate-400">Essas opcoes controlam o checkout do participante. Mostraremos apenas as formas habilitadas abaixo.</p>

        <div className="mt-4 space-y-2 text-sm text-slate-200">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.pix_enabled}
              onChange={(event) => setForm((prev) => ({ ...prev, pix_enabled: event.target.checked }))}
            />
            PIX
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.credit_card_single_enabled}
              onChange={(event) => setForm((prev) => ({ ...prev, credit_card_single_enabled: event.target.checked }))}
            />
            Credito a vista
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.credit_card_installments_enabled}
              onChange={(event) => setForm((prev) => ({ ...prev, credit_card_installments_enabled: event.target.checked }))}
            />
            Credito parcelado
          </label>
        </div>

        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="mt-4 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60"
        >
          {isPending ? "Salvando..." : "Salvar e ir para próxima etapa"}
        </button>
      </div>
    </div>
  );
}
