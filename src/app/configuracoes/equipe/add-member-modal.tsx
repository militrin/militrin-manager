'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addTeamMemberAction, searchPromotableUsersAction } from './actions';

type Candidate = { userId: string; fullName: string; maskedEmail: string };
type RoleOption = { id: string; name: string };
type Step = 'search' | 'confirm';

export function AddTeamMemberButton({ roleOptions }: { roleOptions: RoleOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('search');
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Candidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [roleId, setRoleId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setStep('search');
    setTerm('');
    setResults([]);
    setSearched(false);
    setSelected(null);
    setRoleId('');
    setMessage(null);
  }

  function closeModal() {
    setOpen(false);
    reset();
  }

  function runSearch() {
    setMessage(null);
    startTransition(async () => {
      const response = await searchPromotableUsersAction(term);
      setSearched(true);
      if (!response.success) {
        setResults([]);
        setMessage(response.message ?? 'Não foi possível buscar.');
        return;
      }
      setResults(response.results);
    });
  }

  function pickCandidate(candidate: Candidate) {
    setSelected(candidate);
    setStep('confirm');
    setMessage(null);
  }

  function backToSearch() {
    setStep('search');
    setSelected(null);
    setRoleId('');
    setMessage(null);
  }

  function confirmAdd() {
    if (!selected) return;
    if (!roleId) {
      setMessage('Selecione uma função antes de confirmar.');
      return;
    }
    startTransition(async () => {
      const response = await addTeamMemberAction({ userId: selected.userId, roleId });
      if (!response.success) {
        setMessage(response.message ?? 'Não foi possível adicionar o membro.');
        return;
      }
      const addedUserId = selected.userId;
      closeModal();
      // Abre direto o editor completo do novo membro -- proximo passo
      // natural depois de escolher a funcao base e' ajustar permissoes
      // individuais, se necessario. A lista em si tambem ja fica
      // atualizada (revalidatePath na action) pra quando o usuario voltar.
      router.push(`/painel/configuracoes/equipe/${addedUserId}`);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-10 rounded-xl bg-emerald-400 px-4 text-xs font-semibold text-slate-950"
      >
        + Adicionar membro
      </button>

      {open ? (
        <div role="dialog" aria-modal="true" aria-label="Adicionar membro à equipe" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <button type="button" aria-label="Fechar" onClick={closeModal} className="absolute inset-0" />
          <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-100">Adicionar membro</h2>
              <button type="button" onClick={closeModal} className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300">
                Fechar
              </button>
            </div>

            {step === 'search' ? (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-slate-400">Busque por nome ou e-mail entre contas já existentes que ainda não fazem parte da equipe.</p>
                <div className="flex gap-2">
                  <input
                    value={term}
                    onChange={(event) => setTerm(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter' && term.trim().length >= 3) runSearch(); }}
                    placeholder="Nome ou e-mail (mín. 3 caracteres)"
                    className="h-10 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                  />
                  <button
                    type="button"
                    onClick={runSearch}
                    disabled={isPending || term.trim().length < 3}
                    className="h-10 rounded-xl bg-emerald-400 px-4 text-xs font-semibold text-slate-950 disabled:opacity-50"
                  >
                    {isPending ? 'Buscando...' : 'Buscar'}
                  </button>
                </div>

                {message ? <p className="text-sm text-amber-200">{message}</p> : null}

                {searched && !message && results.length === 0 ? (
                  <p className="text-sm text-slate-400">Nenhuma conta elegível encontrada -- ou já é membro da equipe, ou o termo não bateu com nome/e-mail.</p>
                ) : null}

                {results.length > 0 ? (
                  <ul className="max-h-72 space-y-2 overflow-y-auto">
                    {results.map((candidate) => (
                      <li key={candidate.userId}>
                        <button
                          type="button"
                          onClick={() => pickCandidate(candidate)}
                          className="w-full rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-left transition hover:border-emerald-400/50"
                        >
                          <p className="text-sm font-medium text-slate-100">{candidate.fullName}</p>
                          <p className="text-xs text-slate-400">{candidate.maskedEmail}</p>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : selected ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Você está prestes a adicionar</p>
                  <p className="mt-1 text-base font-semibold text-slate-100">{selected.fullName}</p>
                  <p className="text-sm text-slate-400">{selected.maskedEmail}</p>
                </div>

                <label className="block space-y-1 text-sm text-slate-300">
                  <span>Função base</span>
                  <select
                    value={roleId}
                    onChange={(event) => setRoleId(event.target.value)}
                    className="h-10 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                  >
                    <option value="">Selecione uma função</option>
                    {roleOptions.map((role) => (
                      <option key={role.id} value={role.id}>{role.name}</option>
                    ))}
                  </select>
                </label>

                {roleId ? (
                  <p className="text-xs text-slate-400">
                    {selected.fullName} vai entrar na equipe como <span className="font-semibold text-slate-200">{roleOptions.find((role) => role.id === roleId)?.name}</span>, ativo imediatamente.
                  </p>
                ) : null}

                {message ? <p className="text-sm text-rose-300">{message}</p> : null}

                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={backToSearch} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200">
                    Voltar
                  </button>
                  <button
                    type="button"
                    onClick={confirmAdd}
                    disabled={isPending || !roleId}
                    className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
                  >
                    {isPending ? 'Adicionando...' : 'Confirmar'}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
