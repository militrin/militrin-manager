"use client";

import { useState, useTransition } from "react";
import { deleteEventScheduleAction, upsertEventScheduleAction } from "@/app/eventos/actions";
import { formatDateBR, toDatetimeLocalValue } from "@/lib/utils/date";
import { DateTimeField } from "@/components/forms/DateTimeField";

export type EventScheduleRow = {
  id: string; event_id: string; delivery_at: string; title: string;
  location: string | null; description: string | null; schedule_type: string;
  sort_order: number; is_active: boolean; is_visible_to_users: boolean;
};

const types = [
  ['kit_pickup', 'Retirada de kit'], ['gates_open', 'Abertura dos portões'],
  ['event_start', 'Início do evento'], ['attraction', 'Atração/show'],
  ['accreditation', 'Credenciamento'], ['meeting', 'Encontro'],
  ['closing', 'Encerramento'], ['other', 'Outro'],
] as const;

const emptyForm = { id: '', delivery_at: '', title: '', location: '', description: '', schedule_type: 'other', sort_order: '0', is_active: true, is_visible_to_users: true };

export function DeliveryScheduleManager({ eventId, initialRows }: { eventId: string; initialRows: EventScheduleRow[] }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [rows, setRows] = useState(initialRows);
  const [form, setForm] = useState(emptyForm);

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await upsertEventScheduleAction({
        id: form.id || undefined, event_id: eventId, delivery_at: form.delivery_at,
        title: form.title, location: form.location || null, description: form.description || null,
        schedule_type: form.schedule_type as typeof types[number][0], sort_order: Number(form.sort_order || 0),
        is_active: form.is_active, is_visible_to_users: form.is_visible_to_users,
      });
      setMessage({ type: result.success ? 'success' : 'error', text: result.message });
      if (!result.success) return;
      const next: EventScheduleRow = { id: form.id || String(result.id), event_id: eventId, delivery_at: new Date(form.delivery_at).toISOString(), title: form.title, location: form.location || null, description: form.description || null, schedule_type: form.schedule_type, sort_order: Number(form.sort_order || 0), is_active: form.is_active, is_visible_to_users: form.is_visible_to_users };
      setRows((current) => [...(current.some((row) => row.id === next.id) ? current.map((row) => row.id === next.id ? next : row) : [...current, next])].sort((a, b) => new Date(a.delivery_at).getTime() - new Date(b.delivery_at).getTime()));
      setForm(emptyForm);
    });
  }

  function edit(row: EventScheduleRow) { setForm({ ...row, delivery_at: toDatetimeLocalValue(row.delivery_at), location: row.location ?? '', description: row.description ?? '', sort_order: String(row.sort_order) }); }
  function remove(id: string) { startTransition(async () => { const result = await deleteEventScheduleAction(id, eventId); setMessage({ type: result.success ? 'success' : 'error', text: result.message }); if (result.success) setRows((current) => current.filter((row) => row.id !== id)); }); }

  const inputClass = "w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2";
  return <div className="space-y-4">
    {message ? <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === 'success' ? 'border-emerald-500/30 text-emerald-200' : 'border-red-500/30 text-red-200'}`}>{message.text}</div> : null}
    <div className="grid gap-3 md:grid-cols-2">
      <DateTimeField label="Data e horário" value={form.delivery_at} onChange={(next) => setForm({ ...form, delivery_at: next })} />
      <label className="space-y-1 text-sm"><span>Título</span><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputClass} /></label>
      <label className="space-y-1 text-sm"><span>Tipo</span><select value={form.schedule_type} onChange={(e) => setForm({ ...form, schedule_type: e.target.value })} className={inputClass}>{types.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="space-y-1 text-sm"><span>Local (opcional)</span><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={inputClass} /></label>
      <label className="space-y-1 text-sm md:col-span-2"><span>Descrição (opcional)</span><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputClass} rows={3} /></label>
      <label className="space-y-1 text-sm"><span>Ordem de desempate</span><input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} className={inputClass} /></label>
    </div>
    <div className="flex flex-wrap gap-4 text-sm"><label><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Ativo</label><label><input type="checkbox" checked={form.is_visible_to_users} onChange={(e) => setForm({ ...form, is_visible_to_users: e.target.checked })} /> Visível para usuários</label></div>
    <div className="flex gap-2"><button type="button" disabled={isPending} onClick={save} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">{form.id ? 'Atualizar compromisso' : 'Adicionar compromisso'}</button>{form.id ? <button type="button" onClick={() => setForm(emptyForm)} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Cancelar</button> : null}</div>
    <div className="space-y-2">{rows.length === 0 ? <p className="text-sm text-slate-400">Nenhum compromisso configurado para este evento.</p> : rows.map((row) => <article key={row.id} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-sm"><p className="font-semibold text-white">{row.title}</p><p>{formatDateBR(row.delivery_at)} às {toDatetimeLocalValue(row.delivery_at).slice(11, 16)}</p>{row.location ? <p>{row.location}</p> : null}{row.description ? <p className="text-slate-400">{row.description}</p> : null}<p className="text-xs text-slate-500">{row.is_active ? 'Ativo' : 'Inativo'} · {row.is_visible_to_users ? 'Visível' : 'Oculto'}</p><div className="mt-2 flex gap-2"><button onClick={() => edit(row)} className="rounded-lg border border-slate-700 px-3 py-1 text-xs">Editar</button><button onClick={() => remove(row.id)} className="rounded-lg border border-rose-700 px-3 py-1 text-xs text-rose-200">Excluir</button></div></article>)}</div>
  </div>;
}
