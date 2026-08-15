"use client";

import type { Organization } from '@/lib/organizations/types';

type Props = {
  organizations: Organization[];
  currentSlug: string | null;
};

/**
 * Seletor de organização ativa.
 * Não exibido quando o usuário tem apenas uma organização.
 */
export function OrgSelector({ organizations, currentSlug }: Props) {
  if (organizations.length <= 1) return null;

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const slug = e.target.value;
    // Persiste via cookie via server action (preparado para implementação futura)
    document.cookie = `nexora_org=${slug}; path=/; max-age=2592000; samesite=lax`;
    window.location.reload();
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-400">Organização:</span>
      <select
        value={currentSlug ?? ''}
        onChange={handleChange}
        className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
      >
        {organizations.map((org) => (
          <option key={org.id} value={org.slug}>
            {org.name}
          </option>
        ))}
      </select>
    </div>
  );
}
