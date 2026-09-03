"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmImportedPendingPaymentAction } from "./actions";

export function ImportedPaymentConfirmation({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("Confirmação administrativa do pagamento importado");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return <div className="mt-3 space-y-2">
    <label className="block text-xs text-slate-300">
      Motivo da confirmação
      <input value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
    </label>
    <button type="button" disabled={pending || reason.trim().length < 3} onClick={() => startTransition(async () => {
      setMessage(null);
      const result = await confirmImportedPendingPaymentAction({ paymentId, reason });
      setMessage(result.message);
      if (result.success) router.refresh();
    })} className="rounded-xl bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-50">
      {pending ? "Confirmando..." : "Confirmar pagamento importado"}
    </button>
    {message ? <p className="text-xs text-slate-300" role="status">{message}</p> : null}
  </div>;
}
