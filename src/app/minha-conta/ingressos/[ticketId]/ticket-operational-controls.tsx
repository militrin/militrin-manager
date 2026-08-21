"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { MilitrinButton } from "@/components/militrin";
import {
  checkinEntryAction,
  deliverFullKitAction,
  deliverKitAndCheckinAction,
  undoCheckinEntryAction,
  undoFullKitDeliveryAction,
} from "@/app/operacoes/actions";
import { ReasonDialog } from "@/app/operacoes/components/ReasonDialog";
import { WristbandCodeModal } from "@/app/operacoes/components/WristbandCodeModal";

type Result = { success: boolean; message?: string; code?: string };

type MandatoryWristbandMode = "checkin" | "deliver" | "combined" | null;
type UndoMode = "checkin" | "kit" | null;

export function TicketOperationalControls(props: {
  ticketId: string;
  kitFullyDelivered: boolean;
  kitReadyForDelivery: boolean;
  checkinDone: boolean;
  hasActiveWristband: boolean;
  canDeliverKit: boolean;
  canUndoKitDelivery: boolean;
  canCheckin: boolean;
  canUndoCheckin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const [wristbandPrompt, setWristbandPrompt] = useState<MandatoryWristbandMode>(null);
  const [undoPrompt, setUndoPrompt] = useState<UndoMode>(null);

  function run(operation: () => Promise<Result>, onWristbandRequired?: () => void) {
    if (pending) return;
    setResult(null);
    startTransition(async () => {
      try {
        const response = await operation();
        setResult(response);
        if (response.success) {
          router.refresh();
        } else if (response.code === "WRISTBAND_REQUIRED" && onWristbandRequired) {
          onWristbandRequired();
        }
      } catch (error) {
        setResult({ success: false, message: error instanceof Error ? error.message : "Não foi possível concluir a operação." });
      }
    });
  }

  async function submitMandatoryWristband(code: string) {
    const mode = wristbandPrompt;
    const response = mode === "checkin"
      ? await checkinEntryAction({ ticket_id: props.ticketId, wristband_code: code })
      : mode === "deliver"
        ? await deliverFullKitAction({ ticket_id: props.ticketId, wristband_code: code })
        : mode === "combined"
          ? await deliverKitAndCheckinAction({ ticket_id: props.ticketId, wristband_code: code })
          : { success: false, message: "Operação desconhecida." };
    setResult(response);
    if (response.success) router.refresh();
    return { success: response.success, message: response.message };
  }

  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      {props.canDeliverKit && !props.kitFullyDelivered ? (
        <MilitrinButton
          type="button" size="sm" variant="success" disabled={pending || !props.kitReadyForDelivery}
          onClick={() => run(() => deliverFullKitAction({ ticket_id: props.ticketId }), () => setWristbandPrompt("deliver"))}
        >
          Entregar kit
        </MilitrinButton>
      ) : props.kitFullyDelivered && props.canUndoKitDelivery ? (
        <MilitrinButton type="button" size="sm" variant="secondary" disabled={pending} onClick={() => setUndoPrompt("kit")}>Reverter entrega do kit</MilitrinButton>
      ) : props.kitFullyDelivered ? <MilitrinButton type="button" size="sm" variant="secondary" disabled>Kit entregue</MilitrinButton> : null}

      {props.canCheckin && !props.checkinDone ? (
        <MilitrinButton
          type="button" size="sm" variant="warning" disabled={pending}
          onClick={() => run(() => checkinEntryAction({ ticket_id: props.ticketId }), () => setWristbandPrompt("checkin"))}
        >
          Fazer check-in
        </MilitrinButton>
      ) : props.checkinDone && props.canUndoCheckin ? (
        <MilitrinButton type="button" size="sm" variant="warning" disabled={pending} onClick={() => setUndoPrompt("checkin")}>Desfazer check-in</MilitrinButton>
      ) : props.checkinDone ? <MilitrinButton type="button" size="sm" variant="secondary" disabled>Check-in realizado</MilitrinButton> : null}

      {props.canDeliverKit && props.canCheckin && !props.kitFullyDelivered && !props.checkinDone ? (
        <MilitrinButton
          type="button" size="sm" disabled={pending || !props.kitReadyForDelivery}
          onClick={() => run(() => deliverKitAndCheckinAction({ ticket_id: props.ticketId }), () => setWristbandPrompt("combined"))}
        >
          Entregar kit + check-in
        </MilitrinButton>
      ) : null}
    </div>
    {!props.kitReadyForDelivery && !props.kitFullyDelivered ? <p className="text-xs text-amber-200">Confirme o vínculo da camiseta antes de entregar o kit. O check-in pode ser realizado separadamente.</p> : null}
    <p aria-live="polite" className={`text-xs ${result?.success ? "text-emerald-300" : "text-rose-300"}`}>
      {pending ? "Processando operação…" : result?.message ?? ""}
    </p>

    {wristbandPrompt ? (
      <WristbandCodeModal
        title="Vincular pulseira"
        description={wristbandPrompt === "checkin" ? "Este evento exige pulseira vinculada para concluir o check-in." : "Este evento exige pulseira vinculada para concluir a entrega do kit."}
        submitLabel="Vincular e continuar"
        mandatory
        onSubmit={submitMandatoryWristband}
        onClose={() => setWristbandPrompt(null)}
      />
    ) : null}

    {undoPrompt === "checkin" ? (
      <ReasonDialog
        title="Desfazer check-in"
        submitLabel="Desfazer check-in"
        extraOptionLabel={props.hasActiveWristband ? "Também desvincular a pulseira" : undefined}
        onSubmit={async ({ reasonCode, reasonText, extraOption }) => {
          const response = await undoCheckinEntryAction({ ticket_id: props.ticketId, reason_code: reasonCode, reason_text: reasonText, also_unlink_wristband: extraOption });
          setResult(response);
          if (response.success) router.refresh();
          return { success: response.success, message: response.message };
        }}
        onClose={() => setUndoPrompt(null)}
      />
    ) : null}

    {undoPrompt === "kit" ? (
      <ReasonDialog
        title="Desfazer entrega do kit"
        description="Os itens baixados nesta entrega voltam ao estoque."
        submitLabel="Desfazer entrega"
        onSubmit={async ({ reasonCode, reasonText }) => {
          const response = await undoFullKitDeliveryAction({ ticket_id: props.ticketId, reason_code: reasonCode, reason_text: reasonText });
          setResult(response);
          if (response.success) router.refresh();
          return { success: response.success, message: response.message };
        }}
        onClose={() => setUndoPrompt(null)}
      />
    ) : null}
  </div>;
}
