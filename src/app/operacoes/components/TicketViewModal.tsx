"use client";

import { useEffect, useState } from "react";
import { TicketViewer } from "@/components/public/TicketViewer";
import { getOperationTicketViewAction } from "../actions";

type TicketView = {
  eventName: string;
  participantName: string;
  status: string;
  categoryName: string | null;
  eventDate: string | null;
  eventLocation: string | null;
  token: string;
  orderNumber: string | null;
};

/**
 * "Ver ingresso" -- somente leitura, nunca confundir com "Emitir ingresso"
 * (que cria um ingresso novo). Reusa o MESMO TicketViewer (com QR real via
 * makeQrUrl e o botao de PDF ja existentes em src/components/public) usado
 * em /minha-conta/ingressos/[ticketId] e /ingressos/[ticketId] -- nao existe
 * QR alternativo aqui. Busca os dados direto pela ticketId (server action
 * dedicada), sem a gate de "canShowTicket" da pagina de conta (que so libera
 * pedido confirmado + ingresso ativo/usado): aqui e uma ficha administrativa,
 * ingresso cancelado ou ja utilizado continuam visualizaveis.
 */
export function TicketViewModal({ ticketId, onClose }: { ticketId: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<TicketView | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getOperationTicketViewAction(ticketId);
      if (cancelled) return;
      if (!result.success || !result.ticket) {
        setError(result.message ?? "Não foi possível carregar o ingresso.");
      } else {
        setTicket(result.ticket);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-2xl rounded-t-3xl border border-emerald-500/30 bg-slate-950 p-5 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-100">Ver ingresso</h3>
          <button type="button" onClick={onClose} className="h-9 rounded-lg border border-slate-700 px-3 text-xs text-slate-300">
            Fechar
          </button>
        </div>

        {loading ? (
          <p className="mt-4 text-sm text-slate-400">Carregando ingresso...</p>
        ) : error || !ticket ? (
          <p className="mt-4 text-sm text-rose-300" role="alert">{error ?? "Ingresso não encontrado."}</p>
        ) : (
          <div className="mt-4">
            <TicketViewer
              eventName={ticket.eventName}
              participantName={ticket.participantName}
              status={ticket.status}
              categoryName={ticket.categoryName}
              eventDate={ticket.eventDate}
              eventLocation={ticket.eventLocation}
              token={ticket.token}
              orderNumber={ticket.orderNumber}
              showPdfButton
            />
          </div>
        )}
      </div>
    </div>
  );
}
