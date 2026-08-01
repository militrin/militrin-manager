'use client';

import { useState } from 'react';
import * as actions from '../actions';

export function EventWristbandSettings({ eventId, initial }: { eventId: string; initial: { enabled: boolean; requiredForKit: boolean; requiredForCheckin: boolean } }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [requiredForKit, setRequiredForKit] = useState(initial.requiredForKit);
  const [requiredForCheckin, setRequiredForCheckin] = useState(initial.requiredForCheckin);
  const [message, setMessage] = useState<string | null>(null);
  async function save() {
    const updateEventWristbandSettingsAction = (
      actions as unknown as {
        updateEventWristbandSettingsAction?: (payload: {
          eventId: string;
          enabled: boolean;
          requiredForKit: boolean;
          requiredForCheckin: boolean;
        }) => Promise<{ message: string }>;
      }
    ).updateEventWristbandSettingsAction;

    if (!updateEventWristbandSettingsAction) {
      setMessage('Ajuste de pulseiras indisponível no momento.');
      return;
    }

    const response = await updateEventWristbandSettingsAction({
      eventId,
      enabled,
      requiredForKit,
      requiredForCheckin,
    });

    setMessage(response.message);
  }
  return <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4"><label className="flex items-center gap-3"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span className="font-semibold">Utilizar pulseiras vinculadas</span></label>{enabled ? <div className="mt-3 space-y-2 pl-6 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={requiredForKit} onChange={(event) => setRequiredForKit(event.target.checked)} />Exigir leitura antes da entrega do kit</label><label className="flex items-center gap-2"><input type="checkbox" checked={requiredForCheckin} onChange={(event) => setRequiredForCheckin(event.target.checked)} />Exigir leitura antes do check-in</label></div> : null}<button type="button" onClick={() => void save()} className="mt-4 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950">Salvar pulseiras</button>{message ? <p className="mt-2 text-sm text-slate-300">{message}</p> : null}</div>;
}
