"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setEventFeaturedOnAccountAction } from "@/app/eventos/actions";

export function AccountHeaderFeaturedToggle({
  eventId,
  featured,
  isActive,
}: {
  eventId: string;
  featured: boolean;
  isActive: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  function toggle(next: boolean) {
    setMessage(null);
    startTransition(async () => {
      const result = await setEventFeaturedOnAccountAction(eventId, next);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) router.refresh();
    });
  }

  return (
    <section className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">Minha Conta</p>
      <h3 className="mt-1 text-base font-semibold text-white">Evento em destaque na Minha Conta</h3>
      <p className="mt-1 text-sm text-slate-300">
        Só um evento da organização aparece no cabeçalho da Minha Conta. Marcar este remove o destaque anterior.
        O cabeçalho some se o evento estiver inativo, arquivado ou já encerrado.
      </p>
      <label className="mt-3 flex items-start gap-2 text-sm text-slate-100">
        <input
          type="checkbox"
          checked={featured}
          disabled={isPending}
          onChange={(event) => toggle(event.target.checked)}
          className="mt-0.5"
        />
        Destacar na Minha Conta
      </label>
      {featured && !isActive ? (
        <p className="mt-2 text-xs text-amber-200">Este evento está inativo: o cabeçalho não aparece até ele ser ativado.</p>
      ) : null}
      {message ? (
        <p className={`mt-2 text-xs ${message.type === "success" ? "text-emerald-200" : "text-rose-200"}`}>{message.text}</p>
      ) : null}
    </section>
  );
}
