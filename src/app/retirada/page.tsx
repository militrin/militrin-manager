"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { SearchInput } from "@/components/mvp/SearchInput";
import {
  checkinEntryAction,
  deliverKitAndCheckinAction,
  deliverFullKitAction,
  deliverKitItemAction,
  getRetiradaCapabilitiesAction,
  getPickupTicketAction,
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
    payment_method: string;
    registration_status: string;
    shirt_type: string;
    shirt_size: string;
    category_name: string;
    event_name: string;
    event_kit_enabled: boolean;
    allow_checkin_during_kit_delivery: boolean;
    ticket_status: string | null;
    ticket_id: string | null;
    ticket_used_at: string | null;
    last_checkin_at: string | null;
    last_checkin_actor: string | null;
    all_kit_delivered: boolean;
    can_operate: boolean;
    block_reason: string | null;
    kit_items: Array<{
      kit_item_id: string;
      item_name: string;
      item_type: string;
      quantity: number;
      status: string;
      delivered_at: string | null;
    }>;
  } | null>(null);
  const [candidates, setCandidates] = useState<Array<{
    contact_id: string; person_name: string; cpf: string; phone: string; ticket_id: string;
    event_id: string; event_name: string; category_name: string; ticket_status: string; holder_name: string;
    shirt: string; kit_status: string | null; checkin_status: string;
  }>>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState({ canDeliverKit: false, canCheckin: false, canCombined: false });

  useEffect(() => {
    void (async () => {
      const response = await getRetiradaCapabilitiesAction();
      if (response.success) {
        setCapabilities(response.capabilities);
      }
    })();
  }, []);

  async function searchParticipant() {
    setLoading(true);
    setMessage(null);
    const response = await searchPickupParticipantAction(query);
    setLoading(false);
    if (response.success && "requires_selection" in response && response.requires_selection) {
      setResult(null);
      setCandidates(response.candidates);
      setMessage("Selecione explicitamente o ingresso correto.");
      return;
    }
    if (!response.success || !("participant" in response) || !response.participant) {
      setResult(null);
      setCandidates([]);
      setMessage(response.message ?? "Nenhum inscrito encontrado.");
      return;
    }
    setCandidates([]);
    setResult(response.participant);
  }

  async function selectTicket(ticketId: string) {
    setLoading(true);
    setMessage(null);
    const response = await getPickupTicketAction(ticketId);
    setLoading(false);
    if (!response.success || !response.participant) {
      setMessage(response.message ?? "Não foi possível abrir o ingresso.");
      return;
    }
    setCandidates([]);
    setResult(response.participant);
  }

  async function refreshSelectedTicket() {
    if (!result?.ticket_id) return;
    const response = await getPickupTicketAction(result.ticket_id);
    if (response.success && response.participant) setResult(response.participant);
  }

  async function deliverKit() {
    if (!result) return;
    setLoading(true);
    try {
      if (!result.ticket_id) return;
      const response = await deliverFullKitAction({ ticket_id: result.ticket_id });
      if (!response.success) {
        setMessage(response.message ?? "Não foi possível entregar o kit.");
        return;
      }
      setMessage("Kit entregue com sucesso.");
      await refreshSelectedTicket();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível entregar o kit.");
    } finally {
      setLoading(false);
    }
  }

  async function deliverItem(kitItemId: string) {
    if (!result) return;
    setLoading(true);
    if (!result.ticket_id) return;
    const response = await deliverKitItemAction({ ticket_id: result.ticket_id, kit_item_id: kitItemId });
    setLoading(false);
    if (!response.success) {
      setMessage(response.message ?? "Não foi possível entregar o item.");
      return;
    }
    setMessage(response.message ?? "Item entregue.");
    await refreshSelectedTicket();
  }

  async function checkinOnly() {
    if (!result) return;
    setLoading(true);
    if (!result.ticket_id) return;
    const response = await checkinEntryAction({ ticket_id: result.ticket_id });
    setLoading(false);
    if (!response.success) {
      setMessage(response.message ?? "Não foi possível confirmar entrada.");
      return;
    }
    setMessage(response.message ?? "Entrada confirmada.");
    await refreshSelectedTicket();
  }

  async function deliverKitAndCheckin() {
    if (!result?.ticket_id) {
      setMessage("Nao foi possivel identificar o ticket para a operacao combinada.");
      return;
    }
    setLoading(true);
    const response = await deliverKitAndCheckinAction({ ticket_id: result.ticket_id });
    setLoading(false);
    if (!response.success) {
      setMessage(response.message ?? "Nao foi possivel concluir a operacao combinada.");
      return;
    }
    setMessage(response.message ?? "Kit entregue e entrada confirmada.");
    await refreshSelectedTicket();
  }

  const disabled = loading || !query.trim();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
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
            {candidates.length ? <div className="mt-5 space-y-4">{Array.from(new Map(candidates.map((item) => [item.contact_id, item])).values()).map((person) => <section key={person.contact_id} className="rounded-3xl border border-slate-700 bg-slate-950/50 p-4"><div><p className="text-lg font-semibold">{person.person_name}</p><p className="text-xs text-slate-400">{person.cpf || "CPF não informado"} · {person.phone || "Telefone não informado"}</p></div><div className="mt-4 space-y-4">{Array.from(new Set(candidates.filter((item) => item.contact_id === person.contact_id).map((item) => item.event_id))).map((eventId) => { const eventTickets = candidates.filter((item) => item.contact_id === person.contact_id && item.event_id === eventId); return <div key={eventId} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-3"><p className="mb-2 text-sm font-semibold text-emerald-200">{eventTickets[0]?.event_name}</p><div className="grid gap-2 sm:grid-cols-2">{eventTickets.map((ticket) => <button key={ticket.ticket_id} type="button" onClick={() => void selectTicket(ticket.ticket_id)} disabled={loading} className="rounded-xl border border-slate-700 bg-slate-950/60 p-3 text-left text-sm transition hover:border-emerald-500"><span className="font-semibold">{ticket.category_name} · #{ticket.ticket_id.slice(0, 8).toUpperCase()}</span><span className="mt-1 block text-xs text-slate-400">Titular: {ticket.holder_name}</span>{ticket.shirt ? <span className="mt-1 block text-xs text-slate-400">Camiseta: {ticket.shirt}</span> : null}<span className="mt-2 block text-xs text-slate-300">{ticket.kit_status ? `Kit: ${ticket.kit_status} · ` : ""}Check-in: {ticket.checkin_status}</span></button>)}</div></div>; })}</div></section>)}</div> : null}
            {result ? (
              <div className="mt-6 rounded-3xl border border-slate-800 bg-slate-900/70 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-lg font-semibold">{result.full_name}</p>
                    <p className="text-sm text-slate-400">#{result.registration_number ?? "—"} · {result.cpf}</p>
                  </div>
                  {result.event_kit_enabled ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={deliverKit}
                        disabled={loading || !result.can_operate || result.all_kit_delivered || !capabilities.canDeliverKit}
                        className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60"
                      >
                        {result.all_kit_delivered ? "KIT JA ENTREGUE" : "ENTREGAR KIT COMPLETO"}
                      </button>
                      <button
                        type="button"
                        onClick={deliverKitAndCheckin}
                        disabled={
                          loading
                          || !result.can_operate
                          || !result.ticket_id
                          || !result.allow_checkin_during_kit_delivery
                          || !capabilities.canCombined
                        }
                        className="rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950 disabled:opacity-60"
                      >
                        ENTREGAR KIT + CHECK-IN
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={checkinOnly}
                      disabled={loading || !result.can_operate || !capabilities.canCheckin}
                      className="rounded-2xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950 disabled:opacity-60"
                    >
                      CONFIRMAR ENTRADA
                    </button>
                  )}
                </div>
                {result.block_reason ? (
                  <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                    Operação bloqueada: {result.block_reason}
                  </div>
                ) : null}
                {result.event_kit_enabled && !result.allow_checkin_during_kit_delivery ? (
                  <div className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-100">
                    Operacao combinada indisponivel: este evento nao permite check-in durante retirada de kit.
                  </div>
                ) : null}
                <div className="mt-4 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
                  <div><p className="text-slate-400">Telefone</p><p>{result.phone}</p></div>
                  <div><p className="text-slate-400">Pagamento</p><p>{result.payment_status === "paid" ? "Confirmado" : "Pendente"}</p></div>
                  <div><p className="text-slate-400">Método</p><p>{result.payment_method}</p></div>
                  <div><p className="text-slate-400">Categoria</p><p>{result.category_name}</p></div>
                  <div><p className="text-slate-400">Camiseta</p><p>{result.shirt_type} · {result.shirt_size}</p></div>
                  <div><p className="text-slate-400">Evento</p><p>{result.event_name}</p></div>
                  <div><p className="text-slate-400">Status do ingresso</p><p>{result.ticket_status ?? "Não emitido"}</p></div>
                  <div><p className="text-slate-400">Check-in anterior</p><p>{result.last_checkin_at ? `${new Date(result.last_checkin_at).toLocaleString("pt-BR")}${result.last_checkin_actor ? ` • ${result.last_checkin_actor}` : ""}` : "Nenhum"}</p></div>
                </div>

                {result.event_kit_enabled ? (
                  <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-200">Itens do participante</p>
                      {result.all_kit_delivered ? <p className="text-xs text-emerald-200">Kit completo já entregue</p> : null}
                    </div>
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
                            disabled={loading || item.status === "delivered" || !result.can_operate}
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
