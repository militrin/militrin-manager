'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { moduleLabel } from '@/lib/admin/permission-module-labels';
import { restoreRolePermissionsDefaultAction, saveRolePermissionsAction } from '../../actions';

type PermissionRow = {
  code: string;
  module: string;
  name: string;
  description: string | null;
  hasPermission: boolean;
  isSystemDefault: boolean;
};

export function RolePermissionsEditor(props: { roleId: string; roleName: string; permissions: PermissionRow[] }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [checkedByCode, setCheckedByCode] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const row of props.permissions) map[row.code] = row.hasPermission;
    return map;
  });

  const initialByCode = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const row of props.permissions) map[row.code] = row.hasPermission;
    return map;
  }, [props.permissions]);

  const isDirty = useMemo(
    () => props.permissions.some((row) => Boolean(checkedByCode[row.code]) !== initialByCode[row.code]),
    [props.permissions, checkedByCode, initialByCode],
  );

  const totalCount = props.permissions.length;
  const selectedCount = useMemo(() => props.permissions.filter((row) => checkedByCode[row.code]).length, [props.permissions, checkedByCode]);

  const searchTerm = search.trim().toLowerCase();
  const visiblePermissions = useMemo(() => {
    if (!searchTerm) return props.permissions;
    return props.permissions.filter(
      (row) =>
        row.name.toLowerCase().includes(searchTerm) ||
        row.code.toLowerCase().includes(searchTerm) ||
        moduleLabel(row.module).toLowerCase().includes(searchTerm),
    );
  }, [props.permissions, searchTerm]);

  const grouped = useMemo(() => {
    const map = new Map<string, PermissionRow[]>();
    for (const row of visiblePermissions) {
      const list = map.get(row.module) ?? [];
      list.push(row);
      map.set(row.module, list);
    }
    return [...map.entries()].sort(([a], [b]) => moduleLabel(a).localeCompare(moduleLabel(b)));
  }, [visiblePermissions]);

  function setModuleChecked(module: string, checked: boolean) {
    setCheckedByCode((prev) => {
      const draft = { ...prev };
      for (const row of props.permissions) {
        if (row.module === module) draft[row.code] = checked;
      }
      return draft;
    });
  }

  function saveChanges() {
    const permissionCodes = props.permissions.filter((row) => checkedByCode[row.code]).map((row) => row.code);
    startTransition(async () => {
      const response = await saveRolePermissionsAction({
        roleId: props.roleId,
        permissionCodes,
        reason: reason.trim() ? reason.trim() : null,
      });
      setMessage(response.message ?? (response.success ? 'Alteracoes salvas.' : 'Falha ao salvar alteracoes.'));
      if (response.success) router.refresh();
    });
  }

  function restoreDefault() {
    startTransition(async () => {
      const response = await restoreRolePermissionsDefaultAction({
        roleId: props.roleId,
        reason: reason.trim() ? reason.trim() : null,
      });
      setMessage(response.message ?? (response.success ? 'Permissoes restauradas.' : 'Falha ao restaurar permissoes.'));
      if (response.success) router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 lg:grid-cols-2">
        <label className="space-y-1 text-sm text-slate-300 lg:col-span-2">
          <span>Buscar permissao</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nome, codigo ou modulo..."
            className="h-10 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
          />
        </label>

        <label className="space-y-1 text-sm text-slate-300 lg:col-span-2">
          <span>Justificativa da alteracao (opcional)</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="h-10 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-2 lg:col-span-2">
          <p className="text-sm text-slate-300">
            <span className="font-semibold text-white">{selectedCount}</span> de <span className="font-semibold text-white">{totalCount}</span> permissoes selecionadas
          </p>
          <button type="button" onClick={restoreDefault} disabled={isPending} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 disabled:opacity-60">
            Restaurar padrao do sistema
          </button>
        </div>

        {isDirty ? (
          <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 lg:col-span-2">
            Voce tem alteracoes nao salvas nesta funcao. Clique em &ldquo;Salvar alteracoes&rdquo; para aplicar -- ate la, nada muda pros usuarios que herdam dela.
          </p>
        ) : null}
      </div>

      {grouped.length === 0 ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-400">Nenhuma permissao encontrada para &ldquo;{search}&rdquo;.</p>
      ) : (
        grouped.map(([module, rows]) => {
          const moduleSelected = rows.filter((row) => checkedByCode[row.code]).length;
          return (
            <section key={module} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-200">
                  {moduleLabel(module)} <span className="normal-case text-slate-500">({moduleSelected}/{rows.length})</span>
                </h3>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setModuleChecked(module, true)} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200">
                    Selecionar todas
                  </button>
                  <button type="button" onClick={() => setModuleChecked(module, false)} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
                    Remover todas
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {rows.map((row) => {
                  const checked = Boolean(checkedByCode[row.code]);
                  const changed = checked !== initialByCode[row.code];
                  return (
                    <label
                      key={row.code}
                      className={`flex cursor-pointer items-start justify-between gap-3 rounded-xl border px-3 py-2 ${changed ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-800 bg-slate-900/70'}`}
                    >
                      <div>
                        <p className="text-sm font-medium text-slate-100">{row.name}</p>
                        <p className="text-xs text-slate-400">
                          {row.code}
                          {row.description ? ` • ${row.description}` : ''}
                          {row.isSystemDefault !== checked ? ' • diferente do padrao do sistema' : ''}
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => setCheckedByCode((prev) => ({ ...prev, [row.code]: event.target.checked }))}
                        className="mt-1 h-5 w-5 shrink-0 accent-emerald-500"
                      />
                    </label>
                  );
                })}
              </div>
            </section>
          );
        })
      )}

      <div className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/90 p-3 backdrop-blur">
        <button type="button" onClick={saveChanges} disabled={isPending || !isDirty} className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60">
          {isPending ? 'Salvando...' : 'Salvar alteracoes'}
        </button>
        {message ? <p className="text-sm text-slate-300">{message}</p> : null}
      </div>
    </div>
  );
}
