"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ParticipantIssuesDialog } from "@/app/inscricoes/participant-issues-dialog";
import { CopyableId } from "@/components/CopyableId";
import type { OperationTicketDetails, PickupCapabilities, PickupEvent } from "../types";

function getAge(birthDate: string | null) {
  if (!birthDate) return null;
  const date = new Date(birthDate);
  if (Number.isNaN(date.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const monthDiff = now.getMonth() - date.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < date.getDate())) {
    age -= 1;
  }

  return age >= 0 ? age : null;
}

function formatGender(value: string | null) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "Não informado";
  if (normalized === "male") return "Masculino";
  if (normalized === "female") return "Feminino";
  return value ?? "Não informado";
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "green" | "yellow" | "red" | "blue" | "gray";
}) {
  const classes = {
    green: "border-emerald-500/35 bg-emerald-500/10 text-emerald-200",
    yellow: "border-amber-500/35 bg-amber-500/10 text-amber-100",
    red: "border-rose-500/35 bg-rose-500/10 text-rose-100",
    blue: "border-cyan-500/35 bg-cyan-500/10 text-cyan-100",
    gray: "border-slate-600 bg-slate-800/70 text-slate-300",
  };

  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${classes[tone]}`}>
      {children}
    </span>
  );
}

export function ExpandedTicketDetails({
  detail,
  busy,
  selectedEvent,
  capabilities,
  onDeliverFullKit,
  onCheckin,
  onDeliverKitAndCheckin,
  onDeliverKitItem,
  onConfirmPayment,
  onIssueResolved,
}: {
  detail: OperationTicketDetails | undefined;
  busy: boolean;
  selectedEvent: PickupEvent | null;
  capabilities: PickupCapabilities;
  onDeliverFullKit: (ticketId: string, participantId: string | null) => Promise<void>;
  onCheckin: (ticketId: string) => Promise<void>;
  onDeliverKitAndCheckin: (ticketId: string, participantId: string | null) => Promise<void>;
  onDeliverKitItem: (ticketId: string, participantId: string | null, kitItemId: string) => Promise<void>;
  onConfirmPayment: (participantId: string) => Promise<void>;
  onIssueResolved: (result: { ticketId: string | null; finalization: string | null; message: string }) => void | Promise<void>;
}) {
  const [isConfirmingPayment, startConfirmPayment] = useTransition();
  const [confirmPaymentError, setConfirmPaymentError] = useState<string | null>(null);
  const age = getAge(detail?.birth_date ?? null);

  if (busy && !detail) {
    return <div className="text-sm text-slate-400">Carregando detalhes...</div>;
  }

  if (!detail) {
    return <div className="text-sm text-rose-200">Não foi possível carregar os detalhes.</div>;
  }

  const shirtOutOfStock = detail.shirt_stock?.status === "out_of_stock";

  return (
    <div className="grid gap-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-sm font-semibold text-slate-100">Dados do ingresso</h3>
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="text-slate-500">Token do ingresso</p>
            <p>{detail.ticket_token || "—"}</p>
          </div>
          <div>
            <p className="text-slate-500">Titular</p>
            <p>{detail.participant_name || "Não informado"}</p>
          </div>
          <div>
            <p className="text-slate-500">Categoria</p>
            <p>{detail.category_name || "Sem categoria"}</p>
          </div>
          <div>
            <p className="text-slate-500">Telefone</p>
            <p>{detail.phone || "—"}</p>
          </div>
          <div>
            <p className="text-slate-500">Cidade</p>
            <p>{detail.city || "Não informado"}</p>
          </div>
          <div>
            <p className="text-slate-500">Método de pagamento</p>
            <p>{detail.payment_method || "—"}</p>
          </div>
          <div>
            <p className="text-slate-500">Gênero</p>
            <p>{formatGender(detail.gender)}</p>
          </div>
          <div>
            <p className="text-slate-500">Nascimento</p>
            <p>
              {detail.birth_date ? new Date(detail.birth_date).toLocaleDateString("pt-BR") : "—"}
              {age === null ? "" : ` · ${age} anos`}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Ordem na compra</p>
            <p>
              {detail.order_ticket_count > 1
                ? `Ingresso ${detail.order_ticket_position} de ${detail.order_ticket_count}`
                : "Ingresso único"}
            </p>
          </div>
        </div>

        {detail.block_reason ? (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            Operação bloqueada: {detail.block_reason}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <CopyableId label="PIN do cadastro" value={detail.registration_contact_pin} />
          {detail.can_issue_ticket ? (
            <Link
              href={detail.registration_contact_pin ? `/ingressos/emitir?pin=${detail.registration_contact_pin}` : "/ingressos/emitir"}
              className="inline-flex h-9 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200"
            >
              Emitir ingresso
            </Link>
          ) : null}
        </div>

        {(detail.issues.length > 0 || detail.payment_status !== "paid") && detail.participant_id ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {detail.issues.length > 0 ? (
              <ParticipantIssuesDialog
                participantId={detail.participant_id}
                participantName={detail.participant_name}
                issues={detail.issues}
                canEdit
                shirtOptions={detail.shirt_options}
                triggerLabel="Revisar pendências"
                onResolved={onIssueResolved}
              />
            ) : null}
            {detail.payment_status !== "paid" ? (
              detail.can_finalize_ticket ? (
                <div>
                  <button
                    type="button"
                    disabled={isConfirmingPayment}
                    onClick={() => {
                      if (!window.confirm(`Confirma o pagamento de "${detail.participant_name}" para o evento "${detail.event_name}"?`)) return;
                      setConfirmPaymentError(null);
                      startConfirmPayment(async () => {
                        try {
                          await onConfirmPayment(detail.participant_id as string);
                        } catch (error) {
                          setConfirmPaymentError(error instanceof Error ? error.message : "Não foi possível confirmar o pagamento.");
                        }
                      });
                    }}
                    className="inline-flex h-10 items-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 text-sm font-semibold text-emerald-200 disabled:opacity-50"
                  >
                    {isConfirmingPayment ? "Confirmando..." : `Confirmar pagamento manualmente — ${detail.event_name}`}
                  </button>
                  {confirmPaymentError ? <p className="mt-2 text-xs text-rose-300" role="alert">{confirmPaymentError}</p> : null}
                </div>
              ) : (
                <p className="text-xs text-slate-400">Você não tem permissão para confirmar pagamentos. Peça a alguém com essa permissão.</p>
              )
            ) : null}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          {detail.shirt_stock && detail.shirt_stock.status !== "not_applicable" ? (
            <div className={`w-full rounded-xl border px-4 py-3 ${shirtOutOfStock ? "border-rose-500/60 bg-rose-500/15 text-rose-100" : detail.shirt_stock.status === "last_unit" ? "border-amber-500/50 bg-amber-500/10 text-amber-100" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"}`} role={shirtOutOfStock ? "alert" : "status"}>
              <p className="font-bold">{detail.shirt_stock.shirt_type} {detail.shirt_stock.shirt_size}</p>
              <p className="text-sm">{shirtOutOfStock ? "SEM ESTOQUE — a entrega não pode ser confirmada." : detail.shirt_stock.status === "last_unit" ? `Última unidade disponível: ${detail.shirt_stock.shirt_type} ${detail.shirt_stock.shirt_size}.` : "Em estoque"}</p>
              {shirtOutOfStock && capabilities.canChangeShirt ? <Link href={`/ingressos/${detail.ticket_id}/editar`} className="mt-2 inline-flex rounded-lg border border-rose-300/50 px-3 py-1.5 text-xs font-semibold">Trocar camiseta</Link> : null}
            </div>
          ) : null}
          <button
            type="button"
            disabled={busy || shirtOutOfStock || !capabilities.canDeliverKit || !detail.can_operate || detail.all_kit_delivered}
            onClick={() => void onDeliverFullKit(detail.ticket_id, detail.participant_id)}
            className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-40"
          >
            Entregar itens
          </button>

          <button
            type="button"
            disabled={busy || !capabilities.canCheckin || !detail.can_operate || detail.checkin_status === "done"}
            onClick={() => void onCheckin(detail.ticket_id)}
            className="rounded-xl border border-cyan-500/50 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-40"
          >
            Fazer check-in
          </button>

          <button
            type="button"
            disabled={busy || shirtOutOfStock || !capabilities.canCombined || !detail.can_operate || detail.checkin_status === "done"}
            onClick={() => void onDeliverKitAndCheckin(detail.ticket_id, detail.participant_id)}
            className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950 disabled:opacity-40"
          >
            Entregar + check-in
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-cyan-500/25 bg-cyan-500/5 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Ingressos da compra</h3>
          <Badge tone="blue">{detail.order_tickets.length} ingresso(s)</Badge>
        </div>

        <div className="mt-3 space-y-2">
          {detail.order_tickets.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhum ingresso relacionado encontrado.</p>
          ) : (
            detail.order_tickets.map((orderTicket, index) => (
              <div key={orderTicket.ticket_id} className="rounded-xl border border-slate-800 bg-slate-950/55 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">
                      Ingresso {index + 1} · {orderTicket.participant_name}
                    </p>
                    <p className="text-xs text-slate-400">{orderTicket.category_name || "Sem categoria"}</p>
                  </div>

                  <Badge
                    tone={
                      orderTicket.ticket_status === "used"
                        ? "green"
                        : orderTicket.ticket_status === "cancelled"
                          ? "red"
                          : "yellow"
                    }
                  >
                    {orderTicket.ticket_status === "used"
                      ? "Utilizado"
                      : orderTicket.ticket_status === "cancelled"
                        ? "Cancelado"
                        : "Pendente"}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-sm font-semibold">Itens</h3>

        <div className="mt-3 space-y-2">
          {!selectedEvent?.has_kit ? (
            <p className="text-sm text-slate-400">Nenhum item se aplica a este ingresso.</p>
          ) : detail.kit_items.length === 0 ? (
            <p className="text-sm text-amber-300">Configuração pendente: os itens aplicáveis ainda não foram vinculados.</p>
          ) : (
            detail.kit_items.map((kitItem) => (
              <div
                key={kitItem.kit_item_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium">
                    {kitItem.item_name} x{kitItem.quantity}
                  </p>
                  <p className="text-xs text-slate-400">{kitItem.status === "delivered" ? "Entregue" : "Pendente"}</p>
                  {kitItem.delivered_at ? (
                    <p className="text-xs text-slate-500">
                      {new Date(kitItem.delivered_at).toLocaleString("pt-BR")} · {kitItem.delivered_by || "Operador não informado"}
                    </p>
                  ) : null}
                </div>

                <button
                  type="button"
                  disabled={busy || kitItem.stock_status === "out_of_stock" || kitItem.status === "delivered" || !detail.can_operate || !capabilities.canDeliverKit}
                  onClick={() => void onDeliverKitItem(detail.ticket_id, detail.participant_id, kitItem.kit_item_id)}
                  className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200 disabled:opacity-40"
                >
                  Entregar item
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-sm font-semibold">Histórico e observações</h3>
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-slate-500">Último check-in</p>
            <p>{detail.last_checkin_at ? new Date(detail.last_checkin_at).toLocaleString("pt-BR") : "Nenhum"}</p>
          </div>
          <div>
            <p className="text-slate-500">Responsável</p>
            <p>{detail.last_checkin_actor || "Não informado"}</p>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm">
          <p className="text-slate-500">Observações</p>
          <p>{detail.block_reason || "Sem observações registradas."}</p>
        </div>
      </div>
    </div>
  );
}
