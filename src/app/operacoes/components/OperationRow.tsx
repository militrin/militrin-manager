"use client";

import { getOperationsGridConfig } from "./tableGrid";
import type { PickupCapabilities, PickupEvent, PickupListItem } from "../types";

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
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${classes[tone]}`}>
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
}: {
  item: PickupListItem;
  selectedEvent: PickupEvent | null;
  isExpanded: boolean;
  busy: boolean;
  capabilities: PickupCapabilities;
  onToggleDetails: (participantId: string) => void;
  onDeliverFullKit: (participantId: string) => Promise<void>;
  onDeliverKitAndCheckin: (participantId: string) => Promise<void>;
  onCheckin: (participantId: string) => Promise<void>;
}) {
  const grid = getOperationsGridConfig(selectedEvent);
  const age = getAge(item.birth_date);
  const gender = formatGender(item.gender);
  const shirtLabel = [item.shirt_type, item.shirt_size].filter(Boolean).join(" ").trim();

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onToggleDetails(item.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggleDetails(item.id);
        }
      }}
      className={`grid grid-cols-1 gap-1.5 px-3 py-2.5 transition hover:bg-slate-800/45 lg:gap-2 ${grid.row} ${
        isExpanded ? "bg-slate-800/45" : "bg-slate-900/55"
      }`}
    >
      <div>
        <div className="flex items-center gap-2">
          <span className="text-slate-500">{isExpanded ? "▼" : "▶"}</span>
          <span className="text-sm font-semibold text-slate-100">{item.full_name}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">
          {(item.city || "Sem cidade") + " · " + gender + " · " + (age === null ? "idade n/i" : `${age} anos`)}
        </div>
        <div className="text-[11px] text-slate-500">CPF {maskCpf(item.cpf)}</div>
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
          <span className="text-slate-500 lg:hidden">Kit: </span>
          {item.kit_status === "delivered" ? (
            <Badge tone="green">Entregue</Badge>
          ) : item.kit_status === "partial" ? (
            <Badge tone="blue">Parcial</Badge>
          ) : item.kit_status === "none" ? (
            <Badge tone="gray">Sem kit</Badge>
          ) : (
            <Badge tone="yellow">Pendente</Badge>
          )}
        </div>
      ) : null}

      <div>
        <span className="text-slate-500 lg:hidden">Check-in: </span>
        {item.checkin_status === "done" ? <Badge tone="green">Realizado</Badge> : <Badge tone="yellow">Pendente</Badge>}
      </div>

      {selectedEvent?.wristband_enabled ? (
        <div>
          <span className="text-slate-500 lg:hidden">Pulseira: </span>
          {item.wristband?.status === "active" ? (
            <Badge tone="green">Vinculada</Badge>
          ) : (
            <Badge tone="yellow">Pendente</Badge>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 lg:content-start" onClick={(event) => event.stopPropagation()}>
        {selectedEvent?.has_kit ? (
          <>
            <button
              type="button"
              disabled={
                busy ||
                !capabilities.canDeliverKit ||
                !item.can_operate ||
                item.kit_status === "delivered" ||
                item.kit_status === "none"
              }
              onClick={() => void onDeliverFullKit(item.id)}
              className="rounded-lg border border-emerald-500/40 px-2 py-1 text-[11px] font-semibold text-emerald-200 disabled:opacity-40"
            >
              Entregar kit
            </button>

            <button
              type="button"
              disabled={busy || !capabilities.canCombined || !item.can_operate || item.checkin_status === "done"}
              onClick={() => void onDeliverKitAndCheckin(item.id)}
              className="rounded-lg bg-cyan-500 px-2 py-1 text-[11px] font-semibold text-cyan-950 disabled:opacity-40"
            >
              Kit + check-in
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy || !capabilities.canCheckin || !item.can_operate || item.checkin_status === "done"}
            onClick={() => void onCheckin(item.id)}
            className="rounded-lg bg-cyan-500 px-2 py-1 text-[11px] font-semibold text-cyan-950 disabled:opacity-40"
          >
            Fazer check-in
          </button>
        )}
      </div>
    </div>
  );
}
