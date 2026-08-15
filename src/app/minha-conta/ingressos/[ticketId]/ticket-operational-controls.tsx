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

type Result = { success: boolean; message: string };

export function TicketOperationalControls(props: {
  ticketId: string;
  kitFullyDelivered: boolean;
  kitReadyForDelivery: boolean;
  checkinDone: boolean;
  canDeliverKit: boolean;
  canUndoKitDelivery: boolean;
  canCheckin: boolean;
  canUndoCheckin: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  function run(operation: () => Promise<Result>) {
    if (pending) return;
    setResult(null);
    startTransition(async () => {
      try {
        const response = await operation();
        setResult(response);
        if (response.success) router.refresh();
      } catch (error) {
        setResult({ success: false, message: error instanceof Error ? error.message : "Não foi possível concluir a operação." });
      }
    });
  }

  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      {props.canDeliverKit && !props.kitFullyDelivered ? <MilitrinButton type="button" size="sm" variant="success" disabled={pending || !props.kitReadyForDelivery} onClick={() => run(() => deliverFullKitAction({ ticket_id: props.ticketId }))}>Entregar kit</MilitrinButton>
        : props.kitFullyDelivered && props.canUndoKitDelivery ? <MilitrinButton type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run(() => undoFullKitDeliveryAction({ ticket_id: props.ticketId }))}>Reverter entrega do kit</MilitrinButton>
        : props.kitFullyDelivered ? <MilitrinButton type="button" size="sm" variant="secondary" disabled>Kit entregue</MilitrinButton> : null}
      {props.canCheckin && !props.checkinDone ? <MilitrinButton type="button" size="sm" variant="warning" disabled={pending} onClick={() => run(() => checkinEntryAction({ ticket_id: props.ticketId }))}>Fazer check-in</MilitrinButton>
        : props.checkinDone && props.canUndoCheckin ? <MilitrinButton type="button" size="sm" variant="warning" disabled={pending} onClick={() => run(() => undoCheckinEntryAction({ ticket_id: props.ticketId }))}>Desfazer check-in</MilitrinButton>
        : props.checkinDone ? <MilitrinButton type="button" size="sm" variant="secondary" disabled>Check-in realizado</MilitrinButton> : null}
      {props.canDeliverKit && props.canCheckin && !props.kitFullyDelivered && !props.checkinDone ? <MilitrinButton type="button" size="sm" disabled={pending || !props.kitReadyForDelivery} onClick={() => run(() => deliverKitAndCheckinAction({ ticket_id: props.ticketId }))}>Entregar kit + check-in</MilitrinButton> : null}
    </div>
    {!props.kitReadyForDelivery && !props.kitFullyDelivered ? <p className="text-xs text-amber-200">Confirme o vínculo da camiseta antes de entregar o kit. O check-in pode ser realizado separadamente.</p> : null}
    <p aria-live="polite" className={`text-xs ${result?.success ? "text-emerald-300" : "text-rose-300"}`}>
      {pending ? "Processando operação…" : result?.message ?? ""}
    </p>
  </div>;
}
