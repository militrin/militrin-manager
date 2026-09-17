"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setOwnerTicketHolderNameAction } from "@/app/minha-conta/actions";
import { setTicketHolderNameAction } from "@/app/ingressos/[ticketId]/editar/actions";

type Mode = "define" | "transfer";

export function TicketHolderActions({
  ticketId,
  mode,
  admin = false,
  currentName = "",
  onSuccess,
}: {
  ticketId: string;
  mode: Mode;
  admin?: boolean;
  currentName?: string;
  onSuccess?: (message: string) => void;
}) {
  const router = useRouter();
  const [holderName, setHolderName] = useState(currentName);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const result = admin
        ? await setTicketHolderNameAction(ticketId, holderName)
        : await setOwnerTicketHolderNameAction(ticketId, holderName);
      setMessage(result.message);
      if (result.success) {
        router.refresh();
        onSuccess?.(result.message);
      }
    });
  }

  return (
    <div className="rounded-xl border border-slate-800 p-3">
      <p className="font-medium">{mode === "define" ? "Definir titular" : "Alterar titular"}</p>
      <p className="mt-1 text-xs text-slate-400">Nome usado para identificar quem utilizará este pacote. Não cria Cadastro e não transfere a propriedade.</p>
      <label className="mt-2 grid gap-1 text-sm">
        <span className="font-medium">Nome do titular</span>
        <input
          value={holderName}
          onChange={(event) => setHolderName(event.target.value)}
          placeholder="João da Silva"
          className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
        />
      </label>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" disabled={pending} onClick={() => setHolderName(currentName)} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Cancelar</button>
        <button type="button" onClick={save} disabled={pending || !holderName.trim()} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50">
          {pending ? "Salvando..." : "Salvar titular"}
        </button>
      </div>
      {message ? <p className="mt-2 text-xs text-slate-400">{message}</p> : null}
    </div>
  );
}
