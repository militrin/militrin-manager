"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getTurboEventsAction } from "../actions";
import { TurboMode } from "../components/TurboMode";
import type { PickupEvent } from "../types";

// Chave de sessionStorage (NUNCA localStorage) que guarda o evento
// escolhido -- so existe enquanto durar UMA operacao Turbo dentro da MESMA
// aba. sessionStorage sobrevive a um F5 (permite "revalidar o contexto
// atual" no meio de uma operacao), mas nunca sobrevive a fechar a aba, e e
// limpo explicitamente ao sair do Turbo (ver useEffect de unmount +
// handleExit abaixo) -- nunca vira persistencia indefinida entre entradas
// independentes.
const TURBO_EVENT_SESSION_KEY = "operacoes.turbo.eventId";

// Ponto de entrada dedicado do Modo Turbo (/operacoes/turbo) -- reaproveita
// o MESMO componente TurboMode ja usado antes dentro de /operacoes (nenhuma
// duplicacao de fluxo/estados/RPCs), so muda quem fornece o evento e o
// destino do "Sair do Modo Turbo": aqui e uma rota propria, entao a saida
// navega de volta pra /operacoes (com o evento e, se aplicavel, o ingresso
// que precisa de intervencao administrativa) em vez de so trocar estado
// local de uma pagina-mae.
export function TurboRouteClient() {
  const router = useRouter();

  const [events, setEvents] = useState<PickupEvent[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<PickupEvent | null>(null);

  useEffect(() => {
    let mounted = true;
    void getTurboEventsAction().then((response) => {
      if (!mounted) return;
      if (!response.success) {
        setMessage(response.message ?? "Não foi possível carregar os eventos.");
        setEvents([]);
        return;
      }
      setEvents(response.events);

      // So reaproveita o evento de uma operacao Turbo JA EM ANDAMENTO (F5
      // no meio da operacao) -- NUNCA a partir de um parametro de URL
      // (?eventId=), que poderia vir de um link antigo/compartilhado e
      // pularia a escolha numa entrada nova. O valor salvo e sempre
      // revalidado contra a lista atual de eventos operaveis; se o evento
      // salvo nao existir mais/nao for mais acessivel, cai pra escolha
      // manual normalmente.
      const storedEventId = window.sessionStorage.getItem(TURBO_EVENT_SESSION_KEY);
      const revalidated = storedEventId ? response.events.find((event) => event.id === storedEventId) : null;
      if (revalidated) setSelectedEvent(revalidated);
      else window.sessionStorage.removeItem(TURBO_EVENT_SESSION_KEY);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    // Descarta o contexto sempre que esta rota e desmontada -- cobre nao so
    // o botao "Sair" (que ja limpa explicitamente antes de navegar, ver
    // handleExit), mas tambem back-button do navegador ou qualquer outra
    // forma de sair da rota sem passar por "Sair do Modo Turbo".
    return () => {
      window.sessionStorage.removeItem(TURBO_EVENT_SESSION_KEY);
    };
  }, []);

  function chooseEvent(event: PickupEvent) {
    window.sessionStorage.setItem(TURBO_EVENT_SESSION_KEY, event.id);
    setSelectedEvent(event);
  }

  function handleExit(focusTicketId?: string) {
    window.sessionStorage.removeItem(TURBO_EVENT_SESSION_KEY);
    const query = new URLSearchParams();
    if (selectedEvent) query.set("eventId", selectedEvent.id);
    if (focusTicketId) query.set("focusTicket", focusTicketId);
    const qs = query.toString();
    router.push(qs ? `/operacoes?${qs}` : "/operacoes");
  }

  if (selectedEvent) {
    return <TurboMode event={selectedEvent} onExit={handleExit} />;
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-xl">
        <p className="text-xs font-bold uppercase tracking-[0.3em] text-cyan-300">Modo Turbo</p>
        <h1 className="mt-1 text-3xl font-black">Selecione o evento</h1>

        {message ? <p className="mt-4 text-sm text-rose-300">{message}</p> : null}

        {events === null ? (
          <p className="mt-6 text-sm text-slate-400">Carregando eventos...</p>
        ) : events.length === 0 && !message ? (
          <p className="mt-6 text-sm text-slate-400">Nenhum evento disponível.</p>
        ) : (
          <div className="mt-6 space-y-2">
            {events.map((event) => (
              <button
                key={event.id}
                type="button"
                onClick={() => chooseEvent(event)}
                className="flex w-full items-center justify-between rounded-2xl border border-slate-700 bg-slate-900 px-5 py-4 text-left text-lg font-semibold transition hover:border-cyan-500"
              >
                {event.name}
                {event.is_active ? <span className="text-xs font-normal text-emerald-300">ativo</span> : null}
              </button>
            ))}
          </div>
        )}

        <a href="/operacoes" className="mt-8 inline-block text-sm text-slate-400 underline">
          Voltar para a Central de Operações
        </a>
      </div>
    </main>
  );
}
