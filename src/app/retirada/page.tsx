"use client";

import { useState } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { SearchInput } from "@/components/mvp/SearchInput";
import {
  checkinEntryAction,
  deliverFullKitAction,
  deliverKitItemAction,
  searchPickupParticipantAction,
} from "./actions";

export default function KitPickupPage() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{
    id: string;
    event_id: string;
    full_name: string;
    registration_number: number | null;
    cpf: string;
    phone: string;
    payment_status: string;
    registration_status: string;
    shirt_type: string;
    shirt_size: string;
    event_name: string;
    event_kit_enabled: boolean;
    kit_items: Array<{
      kit_item_id: string;
      item_name: string;
      item_type: string;
      quantity: number;
      status: string;
      delivered_at: string | null;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function searchParticipant() {
    setLoading(true);
    setMessage(null);
    const response = await searchPickupParticipantAction(query);
    setLoading(false);
    if (!response.success || !response.participant) {
      setResult(null);
      setMessage(response.message ?? "Nenhum inscrito encontrado.");
      return;
    }
    setResult(response.participant);
  }

  async function deliverKit() {
    if (!result) return;
    setLoading(true);
    try {
      const response = await deliverFullKitAction({ participant_id: result.id });
      if (!response.success) {
        setMessage(response.message ?? "Não foi possível entregar o kit.");
        return;
      }
      setMessage("Kit entregue com sucesso.");
      await searchParticipant();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível entregar o kit.");
    } finally {
      setLoading(false);
    }
  }

  async function deliverItem(kitItemId: string) {
    if (!result) return;
    setLoading(true);
    const response = await deliverKitItemAction({ participant_id: result.id, kit_item_id: kitItemId });
    setLoading(false);
    if (!response.success) {
      setMessage(response.message ?? "Não foi possível entregar o item.");
      return;
    }
    setMessage(response.message ?? "Item entregue.");
    await searchParticipant();
  }

  async function checkinOnly() {
    if (!result) return;
    setLoading(true);
    const response = await checkinEntryAction({ participant_id: result.id });
    setLoading(false);
    if (!response.success) {
      setMessage(response.message ?? "Não foi possível confirmar entrada.");
      return;
    }
    setMessage(response.message ?? "Entrada confirmada.");
  }

  const disabled = loading || !query.trim();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Retirada de kits" subtitle="Localize o participante e entregue o kit" />
          <SectionCard title="Busca por participante" description="Busque por CPF, nome, telefone ou número da inscrição.">
            <div className="flex flex-col gap-3 md:flex-row">
              <div className="flex-1">
                <SearchInput value={query} onChange={setQuery} placeholder="CPF, nome ou número" />
              </div>
              <button type="button" onClick={searchParticipant} disabled={disabled} className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">Buscar</button>
            </div>
            {message ? <div className="mt-4 rounded-2xl bg-slate-950/70 p-3 text-sm text-slate-300">{message}</div> : null}
            {result ? (
              <div className="mt-6 rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold">{result.full_name}</p>
                    <p className="text-sm text-slate-400">#{result.registration_number ?? "—"} · {result.cpf}</p>
                  </div>
                  {result.event_kit_enabled ? (
                    <button type="button" onClick={deliverKit} disabled={loading || result.payment_status !== "paid" || result.registration_status === "cancelled"} className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">ENTREGAR KIT COMPLETO</button>
                  ) : (
                    <button type="button" onClick={checkinOnly} disabled={loading || result.payment_status !== "paid" || result.registration_status === "cancelled"} className="rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950 disabled:opacity-60">CONFIRMAR ENTRADA</button>
                  )}
                </div>
                <div className="mt-4 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
                  <div><p className="text-slate-400">Telefone</p><p>{result.phone}</p></div>
                  <div><p className="text-slate-400">Pagamento</p><p>{result.payment_status === "paid" ? "Confirmado" : "Pendente"}</p></div>
                  <div><p className="text-slate-400">Camiseta</p><p>{result.shirt_type} · {result.shirt_size}</p></div>
                  <div><p className="text-slate-400">Evento</p><p>{result.event_name}</p></div>
                </div>

                {result.event_kit_enabled ? (
                  <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                    <p className="text-sm font-semibold text-slate-200">Itens do participante</p>
                    <div className="mt-3 space-y-2">
                      {result.kit_items.length === 0 ? (
                        <p className="text-sm text-slate-400">Nenhum item de kit vinculado.</p>
                      ) : result.kit_items.map((item) => (
                        <div key={item.kit_item_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
                          <div className="text-sm text-slate-200">
                            {item.item_name} x{item.quantity} - {item.status === "delivered" ? "Entregue" : "Pendente"}
                          </div>
                          <button
                            type="button"
                            onClick={() => void deliverItem(item.kit_item_id)}
                            disabled={loading || item.status === "delivered"}
                            className="rounded-lg border border-emerald-500/40 px-2 py-1 text-xs text-emerald-200 disabled:opacity-50"
                          >
                            Entregar item
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                    Evento sem kit: somente check-in de entrada.
                  </div>
                )}
              </div>
            ) : null}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
