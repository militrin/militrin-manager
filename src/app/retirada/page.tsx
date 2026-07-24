"use client";

import { useState } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { SearchInput } from "@/components/mvp/SearchInput";
import { createClient } from "@/lib/supabase/client";
import { deliverKitWithRpc } from "@/lib/supabase/rpc";

export default function KitPickupPage() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{
    id: string;
    full_name: string;
    registration_number: number | null;
    cpf: string;
    phone: string;
    payment_status: string;
    registration_status: string;
    shirt_type: string;
    shirt_size: string;
    events?: { name?: string | null } | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function searchParticipant() {
    const supabase = createClient();
    setLoading(true);
    setMessage(null);
    const { data, error } = await supabase
      .from("participants")
      .select("id, full_name, registration_number, cpf, phone, payment_status, registration_status, shirt_type, shirt_size, events(name)")
      .or(`full_name.ilike.%${query}%,cpf.ilike.%${query}%,phone.ilike.%${query}%,registration_number.eq.${Number(query) || 0}`)
      .limit(1)
      .maybeSingle();
    setLoading(false);
    if (error || !data) {
      setResult(null);
      setMessage("Nenhum inscrito encontrado.");
      return;
    }
    setResult(data as typeof result);
  }

  async function deliverKit() {
    if (!result) return;
    setLoading(true);
    try {
      await deliverKitWithRpc(result.id);
      setMessage("Kit entregue com sucesso.");
      setResult(null);
      setQuery("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível entregar o kit.");
    } finally {
      setLoading(false);
    }
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
                  <button type="button" onClick={deliverKit} disabled={loading || result.payment_status !== "paid" || result.registration_status === "cancelled"} className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">ENTREGAR KIT</button>
                </div>
                <div className="mt-4 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
                  <div><p className="text-slate-400">Telefone</p><p>{result.phone}</p></div>
                  <div><p className="text-slate-400">Pagamento</p><p>{result.payment_status === "paid" ? "Confirmado" : "Pendente"}</p></div>
                  <div><p className="text-slate-400">Camiseta</p><p>{result.shirt_type} · {result.shirt_size}</p></div>
                  <div><p className="text-slate-400">Evento</p><p>{result.events?.name ?? "—"}</p></div>
                </div>
              </div>
            ) : null}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
