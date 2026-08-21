"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { GrantStoreItemModal } from "@/app/operacoes/components/GrantStoreItemModal";
import { grantStoreItemToContactAction } from "./actions";

export function ContactGrantStoreItemButton({
  contactId,
  events,
}: {
  contactId: string;
  events: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-xl border border-emerald-500/50 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/10"
      >
        + Adicionar item
      </button>
      {open ? (
        <GrantStoreItemModal
          events={events}
          onSubmit={async (payload) => {
            const result = await grantStoreItemToContactAction({ contactId, ...payload });
            if (result.success) router.refresh();
            return result;
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
