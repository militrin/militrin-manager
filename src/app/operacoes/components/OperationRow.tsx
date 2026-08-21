"use client";

import { useState } from "react";
import { getOperationsGridConfig } from "./tableGrid";
import type { ActionResult, PickupCapabilities, PickupEvent, PickupListItem } from "../types";
import { MaterializeItemsDialog } from "./MaterializeItemsDialog";
import { ConfirmDeliverAndCheckinDialog } from "./ConfirmDeliverAndCheckinDialog";

function maskCpf(cpf: string) {
  const digits = cpf.replace(/\D/g, "");
  if (digits.length < 5) return cpf;
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
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
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${classes[tone]}`}>
      {children}
    </span>
  );
}

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

export function OperationRow({
  item,
  selectedEvent,
  isExpanded,
  busy,
  capabilities,
  onToggleDetails,
  onDeliverFullKit,
  onDeliverKitAndCheckin,
  onCheckin,
  onItemsMaterialized,
}: {
  item: PickupListItem;
  selectedEvent: PickupEvent | null;
  isExpanded: boolean;
  busy: boolean;
  capabilities: PickupCapabilities;
  onToggleDetails: (entry: PickupListItem) => void;
  onDeliverFullKit: (ticketId: string, participantId: string | null, wristbandCode?: string) => Promise<ActionResult>;
  onDeliverKitAndCheckin: (ticketId: string, participantId: string | null, wristbandCode?: string) => Promise<ActionResult>;
  onCheckin: (ticketId: string, wristbandCode?: string) => Promise<ActionResult>;
  onItemsMaterialized: (ticketId: string) => Promise<void>;
}) {
  const grid = getOperationsGridConfig(selectedEvent);
  const age = getAge(item.birth_date);
  const gender = formatGender(item.gender);
  const shirtLabel = [item.shirt_type, item.shirt_size].filter(Boolean).join(" ").trim();
  const hasTicket = item.kind === "ticket";
  const [showCombinedConfirm, setShowCombinedConfirm] = useState(false);
  const hasActiveWristband = item.wristband?.status === "active";
  const wristbandWillBeRequested = Boolean(
    selectedEvent?.wristband_enabled &&
      (selectedEvent?.wristband_required_for_kit || selectedEvent?.wristband_required_for_checkin) &&
      !hasActiveWristband,
  );

  function toggle() {
    onToggleDetails(item);
  }

  async function handleCombinedConfirmed() {
    if (item.kind === "ticket") await onDeliverKitAndCheckin(item.ticket_id, item.participant_id);
  }

  return (
    <>
    <div
      role="button"
      tabIndex={0}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      }}
      className={`grid grid-cols-1 gap-1.5 px-3 py-2.5 transition hover:bg-slate-800/45 lg:gap-2 ${grid.row} ${
        isExpanded ? "bg-slate-800/45" : "bg-slate-900/55"
      }`}
    >
      <div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500">{hasTicket ? (isExpanded ? "▼" : "▶") : "•"}</span>
          <span className="text-sm font-semibold text-slate-100">
            {item.buyer_type === "imported_holder" ? "Portador" : "Titular"}: {item.participant_name}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">
          {(item.city || "Não informado") + " · " + gender + " · " + (age === null ? "Não informado" : `${age} anos`)}
        </div>
        <div className="text-[11px] text-slate-500">CPF {maskCpf(item.cpf)}</div>
        <div className="text-[11px] text-slate-500">
          {item.kind === "participant_without_ticket"
            ? "Inscrição importada sem ingresso gerado"
            : item.order_ticket_count > 1
            ? `Pedido com ${item.order_ticket_count} ingressos · ingresso ${item.order_ticket_position} de ${item.order_ticket_count}`
            : "Pedido com 1 ingresso"}
        </div>
      </div>

      <div className="text-sm"><span className="text-slate-500 lg:hidden">Categoria: </span>{item.category_name || "—"}</div>

      {selectedEvent?.has_shirt ? (
        <div className="text-sm">
          <span className="text-slate-500 lg:hidden">Camiseta: </span>
          <div className="font-medium text-slate-100">{shirtLabel || "—"}</div>
          {typeof (item as PickupListItem & { shirt_available?: number | null }).shirt_available === "number" &&
          ((item as PickupListItem & { shirt_available?: number | null }).shirt_available ?? 0) <= 3 ? (
            <div className="text-[11px] text-amber-300">
              Estoque baixo: {(item as PickupListItem & { shirt_available?: number | null }).shirt_available}
            </div>
          ) : null}
        </div>
      ) : null}

      <div>
        <span className="text-slate-500 lg:hidden">Pagamento: </span>
        {item.payment_status === "paid" ? <Badge tone="green">Confirmado</Badge> : <Badge tone="yellow">Pendente</Badge>}
      </div>

      {selectedEvent?.has_kit ? (
        <div>
          <span className="text-slate-500 lg:hidden">Itens: </span>
          {item.kit_status === "delivered" ? (
            <Badge tone="green">Entregue</Badge>
          ) : item.kit_status === "partial" ? (
            <Badge tone="blue">Parcial</Badge>
          ) : item.kit_status === "none" ? (
            <Badge tone="gray">Não se aplica</Badge>
          ) : item.kit_status === "configuration_pending" ? (
            <Badge tone="yellow">Configuração pendente</Badge>
          ) : item.kit_status === "error" ? (
            <Badge tone="red">Erro ao consultar</Badge>
          ) : (
            <Badge tone="yellow">Pendente</Badge>
          )}
        </div>
      ) : null}

      <div>
        <span className="text-slate-500 lg:hidden">Check-in: </span>
        {item.checkin_status === "done" ? <Badge tone="green">Realizado</Badge> : <Badge tone="yellow">Pendente</Badge>}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 lg:content-start" onClick={(event) => event.stopPropagation()}>
        {item.kind === "participant_without_ticket" ? (
          <>
            <Badge tone={item.is_imported_without_ticket ? "blue" : "gray"}>
              {item.is_imported_without_ticket ? "Importação sem ingresso" : "Sem ingresso"}
            </Badge>
            <button type="button" onClick={() => onToggleDetails(item)} className="rounded-lg border border-amber-500/40 px-2 py-1 text-[11px] font-semibold text-amber-200">
              Ver detalhes
            </button>
          </>
        ) : item.kit_status === "configuration_pending" ? (
          hasTicket && capabilities.canDeliverKit
            ? <MaterializeItemsDialog ticketId={item.ticket_id} onSuccess={() => onItemsMaterialized(item.id)} />
            : <Badge tone="yellow">Revisar itens</Badge>
        ) : item.kit_status === "error" ? null : item.checkin_status === "done" && (item.kit_status === "delivered" || item.kit_status === "none") ? (
          <Badge tone="green">Concluído</Badge>
        ) : (
          <>
            {selectedEvent?.has_kit && item.kit_status !== "delivered" && item.kit_status !== "none" ? (
            <button
              title="Entregar somente os itens ainda pendentes"
              aria-label="Entregar itens pendentes"
              type="button"
              disabled={
                busy ||
                !capabilities.canDeliverKit ||
                !hasTicket ||
                !item.can_operate
              }
              onClick={() => void onDeliverFullKit(item.ticket_id, item.participant_id)}
              className="rounded-lg border border-emerald-500/40 px-2 py-1 text-[11px] font-semibold text-emerald-200 disabled:opacity-40"
            >
              Entregar itens
            </button>
            ) : null}
            {selectedEvent?.has_kit && item.kit_status !== "delivered" && item.kit_status !== "none" && item.checkin_status !== "done" ? (
            <button
              title="Entregar itens pendentes e depois realizar o check-in"
              aria-label="Entregar itens pendentes e realizar check-in"
              type="button"
              disabled={busy || !capabilities.canCombined || !hasTicket || !item.can_operate}
              onClick={() => setShowCombinedConfirm(true)}
              className="rounded-lg bg-cyan-500 px-2 py-1 text-[11px] font-semibold text-cyan-950 disabled:opacity-40"
            >
              Entregar + check-in
            </button>
            ) : null}
            {item.checkin_status !== "done" && (item.kit_status === "delivered" || item.kit_status === "none" || !selectedEvent?.has_kit) ? (
          <button
            title="Realizar check-in"
            type="button"
            disabled={busy || !capabilities.canCheckin || !hasTicket || !item.can_operate}
            onClick={() => void onCheckin(item.ticket_id)}
            className="rounded-lg bg-cyan-500 px-2 py-1 text-[11px] font-semibold text-cyan-950 disabled:opacity-40"
          >
            Fazer check-in
          </button>
            ) : null}
          </>
        )}
      </div>
    </div>

    {showCombinedConfirm ? (
      <ConfirmDeliverAndCheckinDialog
        participantName={item.participant_name || "Titular não informado"}
        categoryName={item.category_name}
        kitItemLabels={shirtLabel ? [shirtLabel] : []}
        hasKit={Boolean(selectedEvent?.has_kit)}
        wristbandCode={hasActiveWristband ? (item.wristband?.code ?? null) : null}
        wristbandWillBeRequested={wristbandWillBeRequested}
        onConfirm={handleCombinedConfirmed}
        onClose={() => setShowCombinedConfirm(false)}
      />
    ) : null}
    </>
  );
}
