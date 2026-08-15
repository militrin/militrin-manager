"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adminTransferTicketByPinAction, defineTicketHolderByPinAction, findUserByPinAction, transferTicketByPinAction } from "@/app/minha-conta/actions";

type Mode = "define" | "transfer";

export function TicketHolderActions({ ticketId, mode, admin = false, onSuccess }: { ticketId: string; mode: Mode; admin?: boolean; onSuccess?: (message: string) => void }) {
  const router = useRouter();
  const [pin, setPin] = useState(""); const [found, setFound] = useState<{ fullName: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null); const [pending, startTransition] = useTransition();
  function search() { startTransition(async () => { const result = await findUserByPinAction(ticketId, pin); setFound(result.user ?? null); setMessage(result.message); }); }
  function confirm() {
    if (!found) return;
    const prompt = mode === "define" ? `Deseja definir ${found.fullName} como titular deste ingresso?` : `Transferir este ingresso para ${found.fullName}?\n\nApós a transferência, este usuário passará a ser o titular atual.`;
    if (!window.confirm(prompt)) return;
    startTransition(async () => { const result = admin ? await adminTransferTicketByPinAction(ticketId, pin, mode) : mode === "define" ? await defineTicketHolderByPinAction(ticketId, pin) : await transferTicketByPinAction(ticketId, pin); setMessage(result.message); if (result.success) { setFound(null); router.refresh(); onSuccess?.(result.message); } });
  }
  return <div className="rounded-xl border border-slate-800 p-3"><p className="font-medium">{mode === "define" ? "Definir titular" : "Transferir ingresso"}</p>
    <div className="mt-2 flex gap-2"><input value={pin} onChange={(event) => { setPin(event.target.value.toUpperCase()); setFound(null); }} autoComplete="off" placeholder="PIN do usuário" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"/><button type="button" onClick={search} disabled={pending || !pin.trim()} className="rounded-lg border border-slate-700 px-3 py-2">Buscar</button></div>
    {found ? <div className="mt-3 rounded-lg bg-slate-900 p-3"><p>Usuário encontrado</p><p className="font-semibold">{found.fullName}</p><button type="button" onClick={confirm} disabled={pending} className="mt-2 rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-slate-950">{mode === "define" ? "Definir como titular" : "Transferir ingresso"}</button></div> : null}
    {message ? <p className="mt-2 text-xs text-slate-400">{message}</p> : null}
  </div>;
}
