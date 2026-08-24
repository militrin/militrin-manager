"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addTeamMemberAction } from "@/app/configuracoes/equipe/actions";

type RoleOption = { id: string; name: string };

// Reusa a MESMA server action do modal "+ Adicionar membro" de
// /painel/configuracoes/equipe -- nenhum sistema de permissao/RPC paralelo.
// Os dois caminhos (Equipe -> Adicionar membro, Cadastros -> Adicionar à
// equipe) terminam exatamente no mesmo upsert_admin_user_access.
export function AddToTeamButton({ userId, contactId, contactName, roleOptions }: { userId: string; contactId: string; contactName: string; roleOptions: RoleOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [internalNote, setInternalNote] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function closeModal() {
    setOpen(false);
    setRoleId("");
    setIsActive(true);
    setInternalNote("");
    setReason("");
    setMessage(null);
  }

  function submit() {
    if (!roleId) {
      setMessage("Selecione uma função antes de confirmar.");
      return;
    }
    startTransition(async () => {
      const result = await addTeamMemberAction({
        userId,
        roleId,
        isActive,
        internalNote: internalNote.trim() || null,
        reason: reason.trim() || null,
        contactId,
      });
      if (!result.success) {
        setMessage(result.message ?? "Não foi possível adicionar à equipe.");
        return;
      }
      closeModal();
      router.push(`/painel/configuracoes/equipe/${userId}`);
    });
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded-xl border border-emerald-500/40 px-4 py-2 text-sm text-emerald-200 hover:border-emerald-400">
        Adicionar à equipe
      </button>

      {open ? (
        <div role="dialog" aria-modal="true" aria-label="Adicionar à equipe" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <button type="button" aria-label="Fechar" onClick={closeModal} className="absolute inset-0" />
          <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-100">Adicionar à equipe</h2>
              <button type="button" onClick={closeModal} className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300">Fechar</button>
            </div>

            <div className="mt-4 space-y-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Você está prestes a adicionar</p>
                <p className="mt-1 text-base font-semibold text-slate-100">{contactName}</p>
              </div>

              <label className="block space-y-1 text-sm text-slate-300">
                <span>Função base</span>
                <select value={roleId} onChange={(event) => setRoleId(event.target.value)} className="h-10 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100">
                  <option value="">Selecione uma função</option>
                  {roleOptions.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                </select>
              </label>

              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
                Ativo
              </label>

              <label className="block space-y-1 text-sm text-slate-300">
                <span>Nota interna (opcional)</span>
                <textarea value={internalNote} onChange={(event) => setInternalNote(event.target.value)} rows={2} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
              </label>

              <label className="block space-y-1 text-sm text-slate-300">
                <span>Justificativa / motivo</span>
                <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder='Ex.: "Passou a atuar na operação do evento"' className="h-10 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100" />
              </label>

              {message ? <p className="text-sm text-rose-300">{message}</p> : null}

              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={closeModal} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200">Cancelar</button>
                <button type="button" onClick={submit} disabled={isPending || !roleId} className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">
                  {isPending ? "Adicionando..." : "Confirmar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
