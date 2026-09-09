'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  assignSharedEmailAccountOwnerAction,
  deleteOrphanAuthUserAction,
  listEventFirstAccessBlockersAction,
  type FirstAccessAuthConflict,
  type SharedEmailOwnershipGroup,
} from './actions';

function groupKey(group: SharedEmailOwnershipGroup) {
  return group.recommended_contact_id
    || group.current_primary_contact_id
    || group.people[0]?.contact_id
    || group.email_masked;
}

export function SharedEmailAccountGroups({ eventId }: { eventId: string }) {
  const [groups, setGroups] = useState<SharedEmailOwnershipGroup[]>([]);
  const [authConflicts, setAuthConflicts] = useState<FirstAccessAuthConflict[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function load() {
    startTransition(async () => {
      const result = await listEventFirstAccessBlockersAction(eventId);
      if (!result.success) {
        setMessage(result.message);
        return;
      }
      setGroups(result.groups);
      setAuthConflicts(result.authConflicts);
      setSelected(Object.fromEntries(
        result.groups.map((group) => [
          groupKey(group),
          group.current_primary_contact_id ?? group.recommended_contact_id ?? '',
        ]),
      ));
    });
  }

  useEffect(() => {
    if (eventId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recarrega ao trocar o evento
  }, [eventId]);

  const unresolved = groups.filter((group) => !group.resolved);
  const orphans = authConflicts.filter((item) => item.classification === 'ORPHAN_AUTH');
  const realAuth = authConflicts.filter((item) => item.classification === 'ACTIVE_REAL_ACCOUNT');

  return (
    <article id="emails-compartilhados" className="rounded-3xl border border-amber-500/30 bg-amber-500/10 p-5">
      <h2 className="text-xl font-semibold text-amber-50">Revisão de e-mails compartilhados</h2>
      <p className="mt-1 text-sm text-amber-100/80">
        Um e-mail vira um login. Os ingressos do grupo ficam nessa conta, cada um com o titular original.
        Pessoas nao sao fundidas e o owner so e materializado no primeiro acesso.
      </p>
      <div className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
        <p>Grupos: {groups.length}</p>
        <p>Pendentes de conta principal: {unresolved.length}</p>
        <p>Auth orfaos: {orphans.length}</p>
      </div>

      {orphans.length ? (
        <div className="mt-5 space-y-3">
          <h3 className="font-medium text-amber-50">Auth existente sem vinculo operacional</h3>
          {orphans.map((item) => (
            <div key={item.auth_user_id} className="rounded-2xl border border-amber-700/40 bg-slate-950/50 p-4 text-sm">
              <p className="font-semibold">{item.full_name} · PIN {item.pin}</p>
              <p className="text-amber-100/80">{item.email_masked} · classificacao {item.classification}</p>
              <p className="mt-1 text-xs text-slate-400">Vinculos reais: {Number(item.inspect?.real_link_count ?? 0)}</p>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  if (!window.confirm(`Excluir Auth orfao de ${item.full_name}? So e permitido com zero vinculos operacionais.`)) return;
                  startTransition(async () => {
                    const result = await deleteOrphanAuthUserAction(item.auth_user_id);
                    setMessage(result.success ? 'Auth orfao excluido. Reavalie a elegibilidade.' : result.message);
                    if (result.success) load();
                  });
                }}
                className="mt-3 rounded-xl border border-rose-500 px-4 py-2 text-rose-100"
              >
                Excluir Auth orfao
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {realAuth.length ? (
        <div className="mt-5 rounded-2xl border border-rose-700/40 bg-rose-950/30 p-4 text-sm text-rose-100">
          <p className="font-medium">Auth real — nao excluir</p>
          {realAuth.map((item) => (
            <p key={item.auth_user_id} className="mt-1">{item.full_name} · PIN {item.pin} · {item.email_masked}</p>
          ))}
        </div>
      ) : null}

      <div className="mt-5 space-y-4">
        {groups.map((group) => {
          const key = groupKey(group);
          const primaryId = selected[key] || group.recommended_contact_id || '';
          const associated = group.tickets.filter((ticket) => primaryId);
          return (
            <div key={key} className="rounded-2xl border border-slate-700 bg-slate-950/50 p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-amber-300">{group.email_masked}</p>
                  <p className="font-semibold">{group.people_count} Pessoas · {group.tickets.length} ingresso(s)</p>
                </div>
                <span className="h-fit rounded-full bg-slate-800 px-3 py-1 text-xs">
                  {group.resolved ? 'Conta principal definida' : 'Escolher conta principal'}
                  {group.pending_invites ? ` · ${group.pending_invites} convite(s)` : ''}
                </span>
              </div>
              <fieldset className="mt-4 space-y-2">
                <legend className="text-sm font-medium">Conta principal</legend>
                {group.people.map((person) => (
                  <label key={person.contact_id} className="flex items-start gap-3 rounded-xl border border-slate-800 p-3 text-sm">
                    <input
                      type="radio"
                      name={`primary-${key}`}
                      checked={primaryId === person.contact_id}
                      onChange={() => setSelected((current) => ({ ...current, [key]: person.contact_id }))}
                    />
                    <span>
                      <span className="font-semibold">{person.full_name}</span> · PIN {person.pin}
                      {person.contact_id === group.recommended_contact_id ? ' · recomendada' : ''}
                      {person.has_valid_auth ? ' · ja possui Auth' : ''}
                      <span className="block text-xs text-slate-400">
                        Cadastro {person.completeness}/8 · CPF {person.valid_cpf ? 'valido' : 'pendente'} · nascimento {person.has_dob ? 'valido' : 'pendente'}
                        {person.source_row ? ` · linha ${person.source_row}` : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="mt-3 rounded-xl bg-slate-900/80 p-3 text-sm">
                <p className="font-medium">Ingressos que ficarao nesta conta</p>
                {associated.map((ticket) => (
                  <p key={ticket.ticket_id} className="mt-1 text-slate-300">
                    Pedido {ticket.order_label ?? '—'} · titular {ticket.holder_name} (PIN {ticket.holder_pin})
                    {ticket.owner_user_id ? ' · owner ja materializado' : ' · owner apos o claim'}
                  </p>
                ))}
              </div>
              <button
                type="button"
                disabled={pending || !primaryId}
                onClick={() => {
                  const person = group.people.find((item) => item.contact_id === primaryId);
                  if (!window.confirm(`Vincular o grupo ${group.email_masked} a ${person?.full_name}? Os ${associated.length} ingressos permanecem com os titulares originais.`)) return;
                  startTransition(async () => {
                    const result = await assignSharedEmailAccountOwnerAction(eventId, primaryId);
                    setMessage(result.success
                      ? `Grupo vinculado. ${Number(result.result?.tickets_updated ?? associated.length)} ingresso(s) na conta de ${person?.full_name}.`
                      : result.message);
                    if (result.success) load();
                  });
                }}
                className="mt-4 rounded-xl bg-amber-400 px-4 py-2 font-semibold text-amber-950 disabled:opacity-50"
              >
                {group.resolved ? 'Reconfirmar conta principal' : 'Vincular grupo a esta conta'}
              </button>
            </div>
          );
        })}
        {!groups.length && !authConflicts.length ? (
          <p className="text-sm text-amber-100/70">Nenhum e-mail compartilhado nem conflito de Auth neste evento.</p>
        ) : null}
      </div>
      {message ? <p className="mt-4 text-sm text-cyan-100">{message}</p> : null}
    </article>
  );
}
