"use client";

import { useState, useTransition } from "react";
import { updateEventWristbandSettingsAction } from "@/app/eventos/actions";

export type WristbandSettingsValue = {
  enabled: boolean;
  requiredForCheckin: boolean;
  requiredForKit: boolean;
};

/**
 * Configuração de pulseiras do evento -- wristband_enabled/
 * wristband_required_for_checkin/wristband_required_for_kit (colunas ja
 * existentes em public.events, nenhum campo novo). Regra efetiva sempre
 * enabled AND required_for_X, reforcada no backend (set_event_wristband_settings,
 * migration 20260849000000) -- aqui na UI so refletimos essa mesma regra:
 * desativar o uso de pulseiras esconde as exigencias dependentes, nunca deixa
 * o operador configurar um estado que o backend rejeitaria/normalizaria.
 */
export function EventWristbandSettings({ eventId, initial }: { eventId: string; initial: WristbandSettingsValue }) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const isDirty = draft.enabled !== saved.enabled
    || draft.requiredForCheckin !== saved.requiredForCheckin
    || draft.requiredForKit !== saved.requiredForKit;

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await updateEventWristbandSettingsAction({
        eventId,
        enabled: draft.enabled,
        // Mesma regra do backend, espelhada aqui so pra nunca mostrar "salvo"
        // com um valor que o RPC teria normalizado de outro jeito.
        requiredForCheckin: draft.enabled && draft.requiredForCheckin,
        requiredForKit: draft.enabled && draft.requiredForKit,
      });
      if (!result.success) {
        setMessage({ type: "error", text: result.message });
        return;
      }
      const normalized: WristbandSettingsValue = {
        enabled: draft.enabled,
        requiredForCheckin: draft.enabled && draft.requiredForCheckin,
        requiredForKit: draft.enabled && draft.requiredForKit,
      };
      setSaved(normalized);
      setDraft(normalized);
      setMessage({ type: "success", text: result.message });
    });
  }

  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
      <div>
        <h3 className="font-semibold text-slate-100">Pulseiras</h3>
        <p className="text-xs text-slate-500">
          {saved.enabled
            ? `Estado salvo: ativo${saved.requiredForCheckin ? " · obrigatória no check-in" : ""}${saved.requiredForKit ? " · obrigatória na entrega do kit" : ""}`
            : "Estado salvo: pulseiras não utilizadas neste evento"}
        </p>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => setDraft((prev) => ({ ...prev, enabled: event.target.checked }))}
          className="mt-0.5 h-4 w-4 rounded border-slate-600"
        />
        <span>
          <span className="block font-medium text-slate-100">Utilizar pulseiras neste evento</span>
          <span className="block text-xs text-slate-500">Permite vincular uma pulseira individual aos ingressos deste evento.</span>
        </span>
      </label>

      {draft.enabled ? (
        <div className="ml-6 space-y-3 border-l border-slate-800 pl-4">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={draft.requiredForCheckin}
              onChange={(event) => setDraft((prev) => ({ ...prev, requiredForCheckin: event.target.checked }))}
              className="mt-0.5 h-4 w-4 rounded border-slate-600"
            />
            <span>
              <span className="block font-medium text-slate-100">Exigir pulseira no check-in</span>
              <span className="block text-xs text-slate-500">O operador deverá vincular uma pulseira antes de concluir o check-in.</span>
            </span>
          </label>

          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={draft.requiredForKit}
              onChange={(event) => setDraft((prev) => ({ ...prev, requiredForKit: event.target.checked }))}
              className="mt-0.5 h-4 w-4 rounded border-slate-600"
            />
            <span>
              <span className="block font-medium text-slate-100">Exigir pulseira na entrega do kit</span>
              <span className="block text-xs text-slate-500">O operador deverá vincular uma pulseira antes de concluir a entrega do kit.</span>
            </span>
          </label>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending || !isDirty}
          className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-200 disabled:opacity-40"
        >
          {pending ? "Salvando..." : "Salvar configuração de pulseiras"}
        </button>
        {isDirty && !pending ? <span className="text-xs text-amber-300">Alterações não salvas</span> : null}
      </div>

      {message ? (
        <p className={`text-xs ${message.type === "success" ? "text-emerald-300" : "text-rose-300"}`}>{message.text}</p>
      ) : null}
    </div>
  );
}
