"use client";

import { useState } from "react";
import { confirmFirstAccessOtpAction } from "./actions";

export function ConfirmFirstAccessForm({
  tokenHash,
  type,
  next,
  kind,
}: {
  tokenHash: string;
  type: string;
  next: string;
  kind: string;
}) {
  const [pending, setPending] = useState(false);
  const isRecovery = kind === "recovery";

  return (
    <form
      action={confirmFirstAccessOtpAction}
      onSubmit={() => setPending(true)}
      referrerPolicy="no-referrer"
      className="mt-5"
    >
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="next" value={next} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center justify-center rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-emerald-950 disabled:opacity-50"
      >
        {pending ? "Confirmando..." : isRecovery ? "Confirmar redefinição de senha" : "Confirmar primeiro acesso"}
      </button>
    </form>
  );
}
