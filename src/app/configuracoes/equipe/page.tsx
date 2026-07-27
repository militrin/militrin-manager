import Link from 'next/link';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { AdminEmptyState, AdminPageHeader, AdminSection, AdminStatusBadge } from '@/components/admin';
import { requirePermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';

type SearchParams = Promise<{
  q?: string;
  role?: string;
  status?: string;
}>;

export default async function TeamSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePermission('team.view');

  const params = await searchParams;
  const q = String(params.q ?? '');
  const role = String(params.role ?? '');
  const status = String(params.status ?? '');

  const supabase = await createServerSupabaseClient();

  const [{ data: teamRows, error: teamError }, { data: rolesData, error: rolesError }] = await Promise.all([
    supabase.rpc('list_admin_team', {
      p_search: q || null,
      p_role_name: role || null,
      p_status: status || null,
    }),
    supabase.rpc('list_admin_roles'),
  ]);

  if (teamError) throw teamError;
  if (rolesError) throw rolesError;

  const rows = teamRows ?? [];
  const roles = rolesData ?? [];

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader
            title="Equipe e permissoes"
            subtitle="Selecione usuarios e gerencie permissoes individuais por modulo"
          />

          <AdminSection title="Filtros" description="Busque por nome, e-mail, funcao ou status">
            <form className="grid gap-3 md:grid-cols-[1fr_220px_180px_auto]" action="/configuracoes/equipe">
              <input
                type="text"
                name="q"
                defaultValue={q}
                placeholder="Nome ou e-mail"
                className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
              />
              <select name="role" defaultValue={role} className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100">
                <option value="">Todas as funcoes</option>
                {roles.map((item: Record<string, unknown>) => (
                  <option key={String(item.id)} value={String(item.name)}>{String(item.name)}</option>
                ))}
              </select>
              <select name="status" defaultValue={status} className="h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100">
                <option value="">Todos os status</option>
                <option value="active">Ativo</option>
                <option value="inactive">Inativo</option>
              </select>
              <button type="submit" className="h-10 rounded-xl bg-emerald-400 px-4 text-xs font-semibold text-slate-950">Aplicar</button>
            </form>
          </AdminSection>

          <AdminSection title="Usuarios da equipe" description="Clique em editar acesso para ajustar funcao e overrides">
            {rows.length === 0 ? (
              <AdminEmptyState title="Nenhum usuario encontrado" description="Ajuste os filtros para localizar membros da equipe." />
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-slate-800">
                <table className="min-w-[980px] w-full text-left text-sm">
                  <thead className="bg-slate-900/80 text-xs uppercase tracking-wide text-slate-300">
                    <tr>
                      <th className="px-3 py-2">Nome</th>
                      <th className="px-3 py-2">E-mail</th>
                      <th className="px-3 py-2">Funcao</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Permissoes efetivas</th>
                      <th className="px-3 py-2">Ultimo acesso</th>
                      <th className="px-3 py-2 text-right">Acoes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row: Record<string, unknown>) => {
                      const id = String(row.user_id);
                      const active = Boolean(row.is_active);
                      return (
                        <tr key={id} className="border-t border-slate-800/80 bg-slate-950/50">
                          <td className="px-3 py-2 font-medium text-slate-100">{String(row.full_name ?? '')}</td>
                          <td className="px-3 py-2 text-slate-300">{String(row.email ?? '')}</td>
                          <td className="px-3 py-2 text-slate-300">{String(row.role_name ?? 'Sem funcao')}</td>
                          <td className="px-3 py-2">{active ? <AdminStatusBadge status="confirmed" /> : <AdminStatusBadge status="cancelled" />}</td>
                          <td className="px-3 py-2 text-slate-300">{Number(row.effective_permission_count ?? 0)}</td>
                          <td className="px-3 py-2 text-slate-300">
                            {row.last_access_at ? new Date(String(row.last_access_at)).toLocaleString('pt-BR') : '-'}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Link href={`/configuracoes/equipe/${id}`} className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200">
                              Editar acesso
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </AdminSection>
        </div>
      </div>
    </main>
  );
}
