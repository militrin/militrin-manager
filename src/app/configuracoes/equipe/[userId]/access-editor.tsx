"use client";

import { useMemo, useState, useTransition } from 'react';
import { loadUserOverridesAction, saveTeamAccessAction } from '../actions';

type PermissionState = 'inherit' | 'allow' | 'deny';

type PermissionRow = {
  code: string;
  module: string;
  name: string;
  state: PermissionState;
  origin: string;
  isEffective: boolean;
};

type TeamUserOption = {
  userId: string;
  fullName: string;
  email: string;
};

type RoleOption = {
  id: string;
  name: string;
};

function originLabel(origin: string) {
  if (origin === 'inherited_role') return 'Herdada da funcao';
  if (origin === 'allowed_individual') return 'Permitida individualmente';
  if (origin === 'denied_individual') return 'Negada individualmente';
  if (origin === 'owner') return 'Owner';
  if (origin === 'inactive_user') return 'Usuario inativo';
  return 'Sem acesso';
}

function moduleLabel(module: string) {
  const map: Record<string, string> = {
    dashboard: 'Dashboard',
    participants: 'Participantes',
    orders: 'Pedidos',
    finance: 'Financeiro',
    inventory: 'Camisetas e estoque',
    kits: 'Kits',
    checkin: 'Check-in',
    events: 'Eventos',
    batches: 'Lotes',
    categories: 'Categorias',
    coupons: 'Cupons',
    photos: 'Fotos',
    imports: 'Importacoes',
    reports: 'Relatorios',
    team: 'Equipe e seguranca',
    security: 'Equipe e seguranca',
    settings: 'Equipe e seguranca',
  };
  return map[module] ?? module;
}

export function TeamAccessEditor(props: {
  targetUserId: string;
  initialRoleId: string | null;
  initialIsActive: boolean;
  initialInternalNote: string;
  permissions: PermissionRow[];
  roleOptions: RoleOption[];
  copyUsers: TeamUserOption[];
}) {
  const [roleId, setRoleId] = useState<string>(props.initialRoleId ?? '');
  const [isActive, setIsActive] = useState<boolean>(props.initialIsActive);
  const [internalNote, setInternalNote] = useState<string>(props.initialInternalNote);
  const [reason, setReason] = useState<string>('');
  const [simplifiedMode, setSimplifiedMode] = useState<boolean>(false);
  const [copyFromUserId, setCopyFromUserId] = useState<string>('');
  const [message, setMessage] = useState<string | null>(null);
  const [stateByCode, setStateByCode] = useState<Record<string, PermissionState>>(() => {
    const map: Record<string, PermissionState> = {};
    for (const row of props.permissions) {
      map[row.code] = row.state;
    }
    return map;
  });

  const [isPending, startTransition] = useTransition();

  const grouped = useMemo(() => {
    const map = new Map<string, PermissionRow[]>();
    for (const row of props.permissions) {
      const list = map.get(row.module) ?? [];
      list.push(row);
      map.set(row.module, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [props.permissions]);

  const effectiveIncluded = useMemo(() => {
    return props.permissions.filter((row) => {
      const state = stateByCode[row.code] ?? 'inherit';
      if (state === 'allow') return true;
      if (state === 'deny') return false;
      return row.isEffective;
    });
  }, [props.permissions, stateByCode]);

  function setModuleState(module: string, next: PermissionState) {
    setStateByCode((prev) => {
      const draft = { ...prev };
      for (const row of props.permissions) {
        if (row.module === module) {
          draft[row.code] = next;
        }
      }
      return draft;
    });
  }

  function restoreRolePermissions() {
    setStateByCode((prev) => {
      const draft = { ...prev };
      for (const row of props.permissions) {
        draft[row.code] = 'inherit';
      }
      return draft;
    });
  }

  function applyCopyOverrides() {
    if (!copyFromUserId) return;

    startTransition(async () => {
      const response = await loadUserOverridesAction(copyFromUserId);
      if (!response.success) {
        setMessage(response.message ?? 'Nao foi possivel copiar permissoes.');
        return;
      }

      const nextMap: Record<string, PermissionState> = {};
      for (const row of props.permissions) {
        nextMap[row.code] = 'inherit';
      }
      for (const item of response.overrides) {
        if (item.permission_code in nextMap) {
          nextMap[item.permission_code] = item.effect;
        }
      }
      setStateByCode(nextMap);
      setMessage('Permissoes copiadas do usuario selecionado.');
    });
  }

  function saveChanges() {
    const overrides = Object.entries(stateByCode)
      .filter(([, value]) => value !== 'inherit')
      .map(([permission_code, value]) => ({
        permission_code,
        effect: value as 'allow' | 'deny',
      }));

    startTransition(async () => {
      const response = await saveTeamAccessAction({
        targetUserId: props.targetUserId,
        roleId: roleId || null,
        isActive,
        internalNote: internalNote.trim() ? internalNote.trim() : null,
        reason: reason.trim() ? reason.trim() : null,
        overrides,
      });

      setMessage(response.message ?? (response.success ? 'Alteracoes salvas.' : 'Falha ao salvar alteracoes.'));
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 lg:grid-cols-2">
        <label className="space-y-1 text-sm text-slate-300">
          <span>Funcao base</span>
          <select value={roleId} onChange={(event) => setRoleId(event.target.value)} className="h-10 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100">
            <option value="">Sem funcao</option>
            {props.roleOptions.map((role) => (
              <option key={role.id} value={role.id}>{role.name}</option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span>Status do usuario</span>
          <button
            type="button"
            onClick={() => setIsActive((value) => !value)}
            className={`h-10 rounded-xl border px-3 text-left text-sm ${isActive ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/50 bg-rose-500/10 text-rose-200'}`}
          >
            {isActive ? 'Ativo' : 'Inativo'}
          </button>
        </label>

        <label className="space-y-1 text-sm text-slate-300 lg:col-span-2">
          <span>Observacao interna</span>
          <textarea value={internalNote} onChange={(event) => setInternalNote(event.target.value)} rows={3} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
        </label>

        <label className="space-y-1 text-sm text-slate-300 lg:col-span-2">
          <span>Justificativa da alteracao (opcional)</span>
          <input value={reason} onChange={(event) => setReason(event.target.value)} className="h-10 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100" />
        </label>

        <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
          <button type="button" onClick={restoreRolePermissions} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200">
            Restaurar permissoes da funcao
          </button>
          <button type="button" onClick={() => setSimplifiedMode((value) => !value)} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200">
            {simplifiedMode ? 'Voltar ao modo visual completo' : 'Ativar modo simplificado'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:col-span-2">
          <select value={copyFromUserId} onChange={(event) => setCopyFromUserId(event.target.value)} className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100">
            <option value="">Copiar permissoes de outro usuario</option>
            {props.copyUsers.map((user) => (
              <option key={user.userId} value={user.userId}>{user.fullName} - {user.email}</option>
            ))}
          </select>
          <button type="button" onClick={applyCopyOverrides} className="h-10 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-3 text-xs text-cyan-200">
            Copiar permissoes
          </button>
        </div>
      </div>

      {simplifiedMode ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-sm font-semibold text-slate-100">Permissoes incluidas</p>
          <ul className="mt-2 grid gap-1 text-sm text-slate-300 md:grid-cols-2">
            {effectiveIncluded.map((row) => (
              <li key={row.code}>✓ {row.name}</li>
            ))}
          </ul>

          <p className="mt-4 text-sm font-semibold text-slate-100">Permissoes extras</p>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {props.permissions.map((row) => {
              const state = stateByCode[row.code] ?? 'inherit';
              if (state === 'inherit') return null;
              return (
                <label key={row.code} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-200">
                  <span>{row.name}</span>
                  <span className={state === 'allow' ? 'text-emerald-300' : 'text-rose-300'}>{state === 'allow' ? 'Permitido' : 'Negado'}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : (
        grouped.map(([module, rows]) => (
          <section key={module} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-200">{moduleLabel(module)}</h3>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setModuleState(module, 'allow')} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200">Marcar todas</button>
                <button type="button" onClick={() => setModuleState(module, 'deny')} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">Remover todas</button>
                <button type="button" onClick={() => setModuleState(module, 'inherit')} className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200">Restaurar modulo</button>
              </div>
            </div>

            <div className="space-y-2">
              {rows.map((row) => {
                const state = stateByCode[row.code] ?? 'inherit';
                return (
                  <div key={row.code} className="rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-slate-100">{row.name}</p>
                        <p className="text-xs text-slate-400">{row.code} • {originLabel(row.origin)}</p>
                      </div>
                      <div className="inline-flex overflow-hidden rounded-lg border border-slate-700 text-xs">
                        <button type="button" onClick={() => setStateByCode((prev) => ({ ...prev, [row.code]: 'inherit' }))} className={`px-2 py-1 ${state === 'inherit' ? 'bg-slate-700 text-white' : 'bg-slate-950 text-slate-300'}`}>Herdar</button>
                        <button type="button" onClick={() => setStateByCode((prev) => ({ ...prev, [row.code]: 'allow' }))} className={`px-2 py-1 ${state === 'allow' ? 'bg-emerald-600 text-white' : 'bg-slate-950 text-slate-300'}`}>Permitir</button>
                        <button type="button" onClick={() => setStateByCode((prev) => ({ ...prev, [row.code]: 'deny' }))} className={`px-2 py-1 ${state === 'deny' ? 'bg-rose-600 text-white' : 'bg-slate-950 text-slate-300'}`}>Negar</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={saveChanges} disabled={isPending} className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60">
          {isPending ? 'Salvando...' : 'Salvar alteracoes'}
        </button>
        {message ? <p className="text-sm text-slate-300">{message}</p> : null}
      </div>
    </div>
  );
}
