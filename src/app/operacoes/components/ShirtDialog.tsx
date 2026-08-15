'use client';

import { useMemo, useState } from 'react';
import * as actions from '../actions';
import type { OperationDetails } from '../types';

export function ShirtDialog({ details, onClose, onSaved }: { details: OperationDetails; onClose: () => void; onSaved: () => Promise<void> }) {
  const [type, setType] = useState(details.shirt_type);
  const [size, setSize] = useState(details.shirt_size);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const types = useMemo(() => Array.from(new Set(details.shirt_options.map((item) => item.shirt_type))), [details]);
  const sizes = useMemo(() => details.shirt_options.filter((item) => item.shirt_type === type), [details, type]);
  async function save() {
    const changeShirtAction = (
      actions as unknown as {
        changeShirtAction?: (payload: {
          ticketId: string;
          shirtType: string;
          shirtSize: string;
        }) => Promise<{ success: boolean; message: string }>;
      }
    ).changeShirtAction;

    if (!changeShirtAction) {
      setMessage('Troca de camiseta indisponível no momento.');
      return;
    }

    setLoading(true);
    const response = await changeShirtAction({
      ticketId: details.ticket_id,
      shirtType: type,
      shirtSize: size,
    });
    setLoading(false);

    if (!response.success) return setMessage(response.message);

    await onSaved();
    onClose();
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4"><div className="w-full max-w-lg rounded-3xl border border-slate-700 bg-slate-900 p-6"><h2 className="text-xl font-bold">Trocar camiseta</h2><p className="text-sm text-slate-400">{details.full_name}</p><div className="mt-5 grid gap-3 sm:grid-cols-2"><select value={type} onChange={(event) => { setType(event.target.value); setSize(''); }} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">{types.map((item) => <option key={item}>{item}</option>)}</select><select value={size} onChange={(event) => setSize(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Selecione</option>{sizes.map((item) => <option key={`${item.shirt_type}-${item.shirt_size}`} value={item.shirt_size} disabled={item.available <= 0}>{item.shirt_size} — {item.available <= 0 ? 'esgotado' : `${item.available} disponível(is)`}</option>)}</select></div>{message ? <p className="mt-3 text-sm text-rose-300">{message}</p> : null}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-xl border border-slate-700 px-4 py-2">Cancelar</button><button type="button" onClick={() => void save()} disabled={loading || !size} className="rounded-xl bg-emerald-500 px-4 py-2 font-semibold text-emerald-950 disabled:opacity-40">Salvar</button></div></div></div>;
}
