"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ParticipantIssuesDialog } from "@/app/inscricoes/participant-issues-dialog";
import { CopyableId } from "@/components/CopyableId";
import type { ActionResult, OperationTicketDetails, PickupCapabilities, PickupEvent, ReasonPayload } from "../types";
import { WristbandCodeModal } from "./WristbandCodeModal";
import { ReasonDialog } from "./ReasonDialog";
import { GrantStoreItemModal } from "./GrantStoreItemModal";
import { ConfirmDeliverAndCheckinDialog } from "./ConfirmDeliverAndCheckinDialog";
import { TicketViewModal } from "./TicketViewModal";

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

function formatDateTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("pt-BR");
}

function kitItemOperationalLabel(item: OperationTicketDetails["kit_items"][number]) {
  const label = item.item_type === "shirt" && item.shirt_type && item.shirt_size
    ? `${item.shirt_type} — ${item.shirt_size}`
    : item.item_name;
  return item.quantity > 1 ? `${label} x${item.quantity}` : label;
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

type WristbandModalMode = "link" | "replace" | "mandatory-checkin" | "mandatory-deliver" | "mandatory-combined" | "mandatory-item" | null;

export function ExpandedTicketDetails({
  detail,
  busy,
  selectedEvent,
  capabilities,
  onDeliverFullKit,
  onCheckin,
  onDeliverKitAndCheckin,
  onDeliverKitItem,
  onUndoCheckin,
  onUndoKitDelivery,
  onLinkWristband,
  onUnlinkWristband,
  onReplaceWristband,
  onConfirmPayment,
  onIssueResolved,
  onGrantStoreItem,
  onDeliverAdditionalItem,
}: {
  detail: OperationTicketDetails | undefined;
  busy: boolean;
  selectedEvent: PickupEvent | null;
  capabilities: PickupCapabilities;
  onDeliverFullKit: (ticketId: string, participantId: string | null, wristbandCode?: string) => Promise<ActionResult>;
  onCheckin: (ticketId: string, wristbandCode?: string) => Promise<ActionResult>;
  onDeliverKitAndCheckin: (ticketId: string, participantId: string | null, wristbandCode?: string) => Promise<ActionResult>;
  onDeliverKitItem: (ticketId: string, participantId: string | null, kitItemId: string, wristbandCode?: string) => Promise<ActionResult>;
  onUndoCheckin: (ticketId: string, payload: ReasonPayload) => Promise<ActionResult>;
  onUndoKitDelivery: (ticketId: string, payload: ReasonPayload) => Promise<ActionResult>;
  onLinkWristband: (ticketId: string, code: string) => Promise<ActionResult>;
  onUnlinkWristband: (ticketId: string) => Promise<ActionResult>;
  onReplaceWristband: (ticketId: string, code: string) => Promise<ActionResult>;
  onConfirmPayment: (participantId: string) => Promise<void>;
  onIssueResolved: (result: { ticketId: string | null; finalization: string | null; message: string }) => void | Promise<void>;
  onGrantStoreItem: (payload: { storeItemId: string; variantId: string | null; quantity: number; isCourtesy: boolean; reason?: string }) => Promise<ActionResult>;
  onDeliverAdditionalItem: (storeOrderItemId: string) => Promise<ActionResult>;
}) {
  const [isConfirmingPayment, startConfirmPayment] = useTransition();
  const [confirmPaymentError, setConfirmPaymentError] = useState<string | null>(null);
  const [showGrantStoreItem, setShowGrantStoreItem] = useState(false);
  const [additionalItemMessage, setAdditionalItemMessage] = useState<string | null>(null);
  const [wristbandModal, setWristbandModal] = useState<WristbandModalMode>(null);
  // So usado quando wristbandModal === "mandatory-item" -- lembra QUAL linha
  // do kit disparou o modal, pra reenviar a entrega so daquele item (nunca
  // do kit inteiro) depois que a pulseira for vinculada.
  const [pendingKitItemId, setPendingKitItemId] = useState<string | null>(null);
  const [showUndoCheckin, setShowUndoCheckin] = useState(false);
  const [showUndoKit, setShowUndoKit] = useState(false);
  const [showCombinedConfirm, setShowCombinedConfirm] = useState(false);
  const [showTicketView, setShowTicketView] = useState(false);
  const age = getAge(detail?.birth_date ?? null);

  if (busy && !detail) {
    return <div className="text-sm text-slate-400">Carregando detalhes...</div>;
  }

  if (!detail) {
    return <div className="text-sm text-rose-200">Não foi possível carregar os detalhes.</div>;
  }

  const shirtOutOfStock = detail.shirt_stock?.status === "out_of_stock";
  const hasActiveWristband = detail.wristband?.status === "active";
  const wristbandRequiredForCheckin = Boolean(selectedEvent?.wristband_enabled && selectedEvent?.wristband_required_for_checkin);
  const wristbandRequiredForKit = Boolean(selectedEvent?.wristband_enabled && selectedEvent?.wristband_required_for_kit);

  const deliveredKitItems = detail.kit_items.filter((item) => item.status === "delivered" && item.delivered_at);
  const lastDelivery = deliveredKitItems.length > 0
    ? deliveredKitItems.reduce((latest, item) => (!latest.delivered_at || (item.delivered_at ?? "") > latest.delivered_at ? item : latest))
    : null;

  async function handleCheckinClick() {
    const result = await onCheckin(detail!.ticket_id);
    if (result && "code" in result && result.code === "WRISTBAND_REQUIRED") {
      setWristbandModal("mandatory-checkin");
    }
  }

  async function handleDeliverClick() {
    const result = await onDeliverFullKit(detail!.ticket_id, detail!.participant_id);
    if (result && "code" in result && result.code === "WRISTBAND_REQUIRED") {
      setWristbandModal("mandatory-deliver");
    }
  }

  // So dispara a RPC combinada (deliver_items_and_checkin, atomica no
  // backend) depois do clique explicito em ConfirmDeliverAndCheckinDialog --
  // a confirmacao aqui e so UX, nunca entrega e check-in separados.
  async function handleCombinedConfirmed() {
    const result = await onDeliverKitAndCheckin(detail!.ticket_id, detail!.participant_id);
    if (result && "code" in result && result.code === "WRISTBAND_REQUIRED") {
      setWristbandModal("mandatory-combined");
    }
  }

  // Mesmo padrao dos outros 3 botoes principais -- reusa o MESMO
  // WristbandCodeModal (nunca um segundo modal/logica). So guarda qual item
  // disparou o pedido, pra reenviar a entrega isolada desse item quando o
  // codigo for informado.
  async function handleDeliverItemClick(kitItemId: string) {
    const result = await onDeliverKitItem(detail!.ticket_id, detail!.participant_id, kitItemId);
    if (result && "code" in result && result.code === "WRISTBAND_REQUIRED") {
      setPendingKitItemId(kitItemId);
      setWristbandModal("mandatory-item");
    }
  }

  async function handleMandatoryWristbandSubmit(code: string) {
    if (!detail) return { success: false, message: "Ingresso não encontrado." };
    const mode = wristbandModal;
    const result = mode === "mandatory-checkin"
      ? await onCheckin(detail.ticket_id, code)
      : mode === "mandatory-deliver"
        ? await onDeliverFullKit(detail.ticket_id, detail.participant_id, code)
        : mode === "mandatory-combined"
          ? await onDeliverKitAndCheckin(detail.ticket_id, detail.participant_id, code)
          : mode === "mandatory-item" && pendingKitItemId
            ? await onDeliverKitItem(detail.ticket_id, detail.participant_id, pendingKitItemId, code)
            : { success: false, message: "Operação desconhecida." };
    if (!result || !("success" in result) || !result.success) {
      return { success: false, message: (result && "message" in result ? result.message : null) ?? "Não foi possível concluir com esta pulseira." };
    }
    setPendingKitItemId(null);
    return { success: true };
  }

  return (
    <div className="grid gap-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="text-sm font-semibold text-slate-100">Dados do ingresso</h3>
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <p className="text-slate-500">Titular</p>
            <p>{detail.participant_name || "Não informado"}</p>
          </div>
          <div>
            <p className="text-slate-500">Categoria</p>
            <p>{detail.category_name || "Ingresso único"}</p>
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
          <button
            type="button"
            onClick={() => setShowTicketView(true)}
            className="inline-flex h-9 items-center rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 text-xs text-cyan-200"
          >
            Ver ingresso
          </button>
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

        {selectedEvent?.wristband_enabled && capabilities.canViewWristband ? (
          <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Pulseira</p>
            {hasActiveWristband ? (
              <>
                <p className="mt-1 text-sm font-semibold text-slate-100">{detail.wristband?.code} · Ativa</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {capabilities.canReplaceWristband ? (
                    <button type="button" onClick={() => setWristbandModal("replace")} className="rounded-lg border border-cyan-500/40 px-3 py-1.5 text-xs font-semibold text-cyan-200">
                      Trocar pulseira
                    </button>
                  ) : null}
                  {capabilities.canUnlinkWristband ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (!window.confirm("Desvincular a pulseira deste ingresso?")) return;
                        void onUnlinkWristband(detail.ticket_id);
                      }}
                      className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-200"
                    >
                      Desvincular
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <p className="mt-1 text-sm text-slate-300">Pulseira não vinculada</p>
                {capabilities.canLinkWristband ? (
                  <button type="button" onClick={() => setWristbandModal("link")} className="mt-2 rounded-lg border border-cyan-500/40 px-3 py-1.5 text-xs font-semibold text-cyan-200">
                    Vincular pulseira
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          {detail.shirt_stock ? (
            <div className={`w-full rounded-xl border px-4 py-3 ${shirtOutOfStock ? "border-rose-500/60 bg-rose-500/15 text-rose-100" : detail.shirt_stock.status === "last_unit" ? "border-amber-500/50 bg-amber-500/10 text-amber-100" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"}`} role={shirtOutOfStock ? "alert" : "status"}>
              <p className="text-base font-bold">{detail.shirt_stock.shirt_type} — {detail.shirt_stock.shirt_size}</p>
              {detail.shirt_stock.status !== "not_applicable" ? (
                <p className="text-sm">{shirtOutOfStock ? "SEM ESTOQUE — a entrega não pode ser confirmada." : detail.shirt_stock.status === "last_unit" ? `Última unidade disponível: ${detail.shirt_stock.shirt_type} — ${detail.shirt_stock.shirt_size}.` : "Em estoque"}</p>
              ) : null}
              {shirtOutOfStock && capabilities.canChangeShirt ? <Link href={`/ingressos/${detail.ticket_id}/editar`} className="mt-2 inline-flex rounded-lg border border-rose-300/50 px-3 py-1.5 text-xs font-semibold">Trocar camiseta</Link> : null}
            </div>
          ) : null}

          {/* Kit: estado rico quando entregue, ações quando pendente. */}
          {selectedEvent?.has_kit ? (
            detail.all_kit_delivered && detail.kit_items.length > 0 ? (
              <div className="w-full rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-emerald-100">
                <p className="font-semibold">
                  ✓ Kit entregue{lastDelivery?.delivered_at ? ` em ${formatDateTime(lastDelivery.delivered_at)}` : ""}
                  {lastDelivery?.delivered_by ? ` por ${lastDelivery.delivered_by}` : ""}
                </p>
                {capabilities.canUndoKit ? (
                  <button type="button" onClick={() => setShowUndoKit(true)} disabled={busy} className="mt-2 rounded-lg border border-rose-400/50 px-3 py-1.5 text-xs font-semibold text-rose-100 disabled:opacity-40">
                    Desfazer entrega
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col items-start gap-1">
                {wristbandRequiredForKit && !hasActiveWristband ? (
                  <span className="text-[11px] font-medium text-amber-300">Pulseira obrigatória para entregar</span>
                ) : null}
                <button
                  type="button"
                  disabled={busy || shirtOutOfStock || !capabilities.canDeliverKit || !detail.can_operate || detail.all_kit_delivered}
                  onClick={() => void handleDeliverClick()}
                  className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-40"
                >
                  Entregar itens
                </button>
              </div>
            )
          ) : null}

          {/* Check-in: estado rico quando realizado, acao quando pendente. */}
          {detail.checkin_status === "done" ? (
            <div className="w-full rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 py-3 text-cyan-100">
              <p className="font-semibold">
                ✓ Check-in realizado{detail.last_checkin_at ? ` em ${formatDateTime(detail.last_checkin_at)}` : ""}
                {detail.last_checkin_actor ? ` por ${detail.last_checkin_actor}` : ""}
              </p>
              {capabilities.canUndoCheckin ? (
                <button type="button" onClick={() => setShowUndoCheckin(true)} disabled={busy} className="mt-2 rounded-lg border border-rose-400/50 px-3 py-1.5 text-xs font-semibold text-rose-100 disabled:opacity-40">
                  Desfazer check-in
                </button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col items-start gap-1">
              {wristbandRequiredForCheckin && !hasActiveWristband ? (
                <span className="text-[11px] font-medium text-amber-300">Pulseira obrigatória para check-in</span>
              ) : null}
              <button
                type="button"
                disabled={busy || !capabilities.canCheckin || !detail.can_operate}
                onClick={() => void handleCheckinClick()}
                className="rounded-xl border border-cyan-500/50 px-4 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-40"
              >
                Fazer check-in
              </button>
            </div>
          )}

          {(!selectedEvent?.has_kit || !detail.all_kit_delivered) && detail.checkin_status !== "done" ? (
            <button
              type="button"
              disabled={busy || shirtOutOfStock || !capabilities.canCombined || !detail.can_operate}
              onClick={() => setShowCombinedConfirm(true)}
              className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950 disabled:opacity-40"
            >
              Entregar + check-in
            </button>
          ) : null}
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
                    <p className="text-xs text-slate-400">{orderTicket.category_name || "Ingresso único"}</p>
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
                    {kitItemOperationalLabel(kitItem)}
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
                  onClick={() => void handleDeliverItemClick(kitItem.kit_item_id)}
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Itens adicionais</h3>
            <p className="text-xs text-slate-500">Produtos da loja concedidos ou comprados separadamente — nunca fazem parte do kit do ingresso.</p>
          </div>
          {capabilities.canGrantStoreItems ? (
            <button
              type="button"
              onClick={() => setShowGrantStoreItem(true)}
              className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200"
            >
              Adicionar item extra
            </button>
          ) : null}
        </div>

        {additionalItemMessage ? <p className="mt-2 text-xs text-amber-300" role="status">{additionalItemMessage}</p> : null}

        <div className="mt-3 space-y-2">
          {detail.additional_items.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhum item adicional vinculado.</p>
          ) : (
            detail.additional_items.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">
                    {item.store_item_name}
                    {item.variant_label ? ` — ${item.variant_label}` : ""} x{item.quantity}
                  </p>
                  <p className="text-xs text-slate-400">
                    {item.status === "delivered" ? "Entregue" : item.status === "confirmed" ? "Pendente" : "Aguardando pagamento"}
                    {item.is_courtesy ? " · Cortesia" : ""}
                    {" · Origem: "}
                    {item.origin === "admin" ? "Administrativo" : item.origin === "codigo" ? "Código" : "Loja"}
                  </p>
                  {item.delivered_at ? (
                    <p className="text-xs text-slate-500">{new Date(item.delivered_at).toLocaleString("pt-BR")}</p>
                  ) : null}
                </div>
                {item.status === "confirmed" && capabilities.canDeliverStoreItems ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setAdditionalItemMessage(null);
                      void onDeliverAdditionalItem(item.id).then((result) => {
                        if (result && "success" in result && !result.success) {
                          setAdditionalItemMessage(result.message ?? "Não foi possível entregar o item.");
                        }
                      });
                    }}
                    className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200 disabled:opacity-40"
                  >
                    Entregar
                  </button>
                ) : item.status === "reserved" ? (
                  <span className="text-xs text-amber-300">Aguardando confirmação de pagamento</span>
                ) : null}
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

      {wristbandModal === "link" ? (
        <WristbandCodeModal
          title="Vincular pulseira"
          submitLabel="Vincular"
          onSubmit={async (code) => (await onLinkWristband(detail.ticket_id, code)) as { success: boolean; message?: string }}
          onClose={() => setWristbandModal(null)}
        />
      ) : null}

      {wristbandModal === "replace" ? (
        <WristbandCodeModal
          title="Trocar pulseira"
          description="A pulseira atual será substituída pela nova."
          submitLabel="Trocar"
          onSubmit={async (code) => (await onReplaceWristband(detail.ticket_id, code)) as { success: boolean; message?: string }}
          onClose={() => setWristbandModal(null)}
        />
      ) : null}

      {wristbandModal === "mandatory-checkin" || wristbandModal === "mandatory-deliver" || wristbandModal === "mandatory-combined" || wristbandModal === "mandatory-item" ? (
        <WristbandCodeModal
          title="Vincular pulseira"
          description={
            wristbandModal === "mandatory-checkin"
              ? "Este evento exige pulseira vinculada para concluir o check-in."
              : "Este evento exige pulseira vinculada para concluir a entrega do kit."
          }
          submitLabel="Vincular e continuar"
          mandatory
          onSubmit={handleMandatoryWristbandSubmit}
          onClose={() => { setWristbandModal(null); setPendingKitItemId(null); }}
        />
      ) : null}

      {showUndoCheckin ? (
        <ReasonDialog
          title="Desfazer check-in"
          description={`Ingresso de ${detail.participant_name || "titular não informado"}.`}
          submitLabel="Desfazer check-in"
          extraOptionLabel={hasActiveWristband ? "Também desvincular a pulseira" : undefined}
          onSubmit={async ({ reasonCode, reasonText, extraOption }) => {
            const result = await onUndoCheckin(detail.ticket_id, { reasonCode, reasonText, alsoUnlinkWristband: extraOption });
            if (!result || !("success" in result) || !result.success) {
              return { success: false, message: (result && "message" in result ? result.message : null) ?? "Não foi possível desfazer o check-in." };
            }
            return { success: true };
          }}
          onClose={() => setShowUndoCheckin(false)}
        />
      ) : null}

      {showUndoKit ? (
        <ReasonDialog
          title="Desfazer entrega do kit"
          description={`Ingresso de ${detail.participant_name || "titular não informado"}. Os itens baixados nesta entrega voltam ao estoque.`}
          submitLabel="Desfazer entrega"
          onSubmit={async ({ reasonCode, reasonText }) => {
            const result = await onUndoKitDelivery(detail.ticket_id, { reasonCode, reasonText, alsoUnlinkWristband: false });
            if (!result || !("success" in result) || !result.success) {
              return { success: false, message: (result && "message" in result ? result.message : null) ?? "Não foi possível desfazer a entrega." };
            }
            return { success: true };
          }}
          onClose={() => setShowUndoKit(false)}
        />
      ) : null}

      {showGrantStoreItem ? (
        <GrantStoreItemModal
          eventId={detail.event_id}
          onSubmit={onGrantStoreItem}
          onClose={() => setShowGrantStoreItem(false)}
        />
      ) : null}

      {showCombinedConfirm ? (
        <ConfirmDeliverAndCheckinDialog
          participantName={detail.participant_name || "Titular não informado"}
          categoryName={detail.category_name}
          kitItemLabels={detail.kit_items
            .filter((item) => item.status !== "delivered")
            .map(kitItemOperationalLabel)}
          hasKit={Boolean(selectedEvent?.has_kit)}
          wristbandCode={hasActiveWristband ? (detail.wristband?.code ?? null) : null}
          wristbandWillBeRequested={(wristbandRequiredForKit || wristbandRequiredForCheckin) && !hasActiveWristband}
          onConfirm={handleCombinedConfirmed}
          onClose={() => setShowCombinedConfirm(false)}
        />
      ) : null}

      {showTicketView ? (
        <TicketViewModal ticketId={detail.ticket_id} onClose={() => setShowTicketView(false)} />
      ) : null}
    </div>
  );
}
