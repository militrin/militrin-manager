"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteCadastroAction } from "./actions";

export function DeleteCadastroButton({ contactId, fullName }: { contactId: string; fullName: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function remove() {
    const confirmation = window.prompt(`Para excluir definitivamente, digite o nome completo:\n\n${fullName}`);
    if (confirmation === null) return;
    const reason = window.prompt("Informe o motivo da exclusao:");
    if (reason === null) return;
    setMessage(null);
    startTransition(async () => {
      const result = await deleteCadastroAction({ contactId, confirmation, reason });
      if (!result.success) {
        setMessage(result.message);
        return;
      }
      router.replace("/cadastros");
      router.refresh();
    });
  }

  return <div className="space-y-2">
    <button type="button" onClick={remove} disabled={isPending} className="rounded-xl border border-rose-500/60 px-5 py-2.5 font-semibold text-rose-200 transition hover:bg-rose-500/10 disabled:opacity-50">
      {isPending ? "Excluindo..." : "Excluir cadastro"}
    </button>
    {message ? <p className="max-w-xl text-sm text-rose-200">{message}</p> : null}
  </div>;
}
