"use client";

import type { PickupCapabilities, PickupDetails, PickupEvent } from "../types";

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

export function ExpandedParticipantDetails({
  detail,
  busy,
  selectedEvent,
  capabilities,
  onDeliverFullKit,
  onCheckin,
  onDeliverKitAndCheckin,
  onDeliverKitItem,
}: {
  detail: PickupDetails | undefined;
  busy: boolean;
  selectedEvent: PickupEvent | null;
  capabilities: PickupCapabilities;
  onDeliverFullKit: (participantId: string) => Promise<void>;
  onCheckin: (participantId: string) => Promise<void>;
  onDeliverKitAndCheckin: (participantId: string) => Promise<void>;
  onDeliverKitItem: (participantId: string, kitItemId: string) => Promise<void>;
}) {
  const age = getAge(detail?.birth_date ?? null);

  if (busy && !detail) {
    return <div className="text-sm text-slate-400">Carregando detalhes...</div>;
  }

  if (!detail) {
    return <div className="text-sm text-rose-200">Não foi possível carregar os detalhes.</div>;
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_1.25fr]">
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <p className="text-slate-500">Telefone</p>
          <p>{detail.phone || "—"}</p>
        </div>
        <div>
          <p className="text-slate-500">Cidade</p>
          <p>{detail.city || "—"}</p>
        </div>
        <div>
          <p className="text-slate-500">Evento</p>
          <p>{detail.event_name}</p>
        </div>
        <div>
          <p className="text-slate-500">Categoria</p>
          <p>{detail.category_name}</p>
        </div>
        <div>
          <p className="text-slate-500">Método de pagamento</p>
          <p>{detail.payment_method}</p>
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
          <p className="text-slate-500">Último check-in</p>
          <p>{detail.last_checkin_at ? new Date(detail.last_checkin_at).toLocaleString("pt-BR") : "Nenhum"}</p>
        </div>
        <div>
          <p className="text-slate-500">Histórico</p>
          <p>
            {detail.last_checkin_actor
              ? `Última ação por ${detail.last_checkin_actor}`
              : "Sem histórico detalhado"}
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 sm:col-span-2">
          <p className="text-slate-500">Observações</p>
          <p>{detail.block_reason || "Sem observações registradas."}</p>
        </div>

        {detail.block_reason ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-100 sm:col-span-2">
            Operação bloqueada: {detail.block_reason}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-2 sm:col-span-2">
          <button
            type="button"
            disabled={busy || !capabilities.canDeliverKit || !detail.can_operate || detail.all_kit_delivered}
            onClick={() => void onDeliverFullKit(detail.id)}
            className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-40"
          >
            Entregar kit completo
          </button>

          <button
            type="button"
            disabled={busy || !capabilities.canCheckin || !detail.can_operate || detail.checkin_status === "done"}
            onClick={() => void onCheckin(detail.id)}
            className="rounded-xl border border-cyan-500/50 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-40"
          >
            Somente check-in
          </button>

          <button
            type="button"
            disabled={busy || !capabilities.canCombined || !detail.can_operate || detail.checkin_status === "done"}
            onClick={() => void onDeliverKitAndCheckin(detail.id)}
            className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950 disabled:opacity-40"
          >
            Entregar kit + check-in
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {detail.purchase_tickets.length > 1 ? (
          <div className="rounded-2xl border border-cyan-500/25 bg-cyan-500/5 p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold">Ingressos desta compra</h3>
              <Badge tone="blue">{detail.purchase_tickets.length} ingressos</Badge>
            </div>

            <div className="mt-3 space-y-2">
              {detail.purchase_tickets.map((purchaseTicket, index) => (
                <div key={purchaseTicket.ticket_id} className="rounded-xl border border-slate-800 bg-slate-950/55 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">
                        Ingresso {index + 1} · {purchaseTicket.holder_name}
                      </p>
                      <p className="text-xs text-slate-400">
                        {purchaseTicket.category_name}
                        {purchaseTicket.shirt_type ? ` · ${purchaseTicket.shirt_type} ${purchaseTicket.shirt_size}` : ""}
                      </p>
                    </div>

                    <Badge
                      tone={
                        purchaseTicket.ticket_status === "used"
                          ? "green"
                          : purchaseTicket.ticket_status === "cancelled"
                            ? "red"
                            : "yellow"
                      }
                    >
                      {purchaseTicket.ticket_status === "used"
                        ? "Utilizado"
                        : purchaseTicket.ticket_status === "cancelled"
                          ? "Cancelado"
                          : "Pendente"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {selectedEvent?.has_kit ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <h3 className="font-semibold">Itens do kit</h3>

            <div className="mt-3 space-y-2">
              {detail.kit_items.length === 0 ? (
                <p className="text-sm text-slate-400">Nenhum item vinculado.</p>
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
                    </div>

                    <button
                      type="button"
                      disabled={busy || kitItem.status === "delivered" || !detail.can_operate || !capabilities.canDeliverKit}
                      onClick={() => void onDeliverKitItem(detail.id, kitItem.kit_item_id)}
                      className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200 disabled:opacity-40"
                    >
                      Entregar item
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
            Este evento não possui kit. A operação disponível é somente o check-in.
          </div>
        )}
      </div>
    </div>
  );
}
