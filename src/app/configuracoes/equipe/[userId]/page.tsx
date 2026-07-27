import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { AdminEmptyState, AdminPageHeader, AdminSection, AdminStatusBadge } from '@/components/admin';
import { requirePermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { TeamAccessEditor } from './access-editor';

export default async function TeamUserAccessPage({ params }: { params: Promise<{ userId: string }> }) {
  await requirePermission('team.edit_permissions');

  const { userId } = await params;
  const supabase = await createServerSupabaseClient();

  const [{ data: userRows, error: userError }, { data: roleRows, error: roleError }, { data: permissionRows, error: permissionError }, { data: teamRows, error: teamError }] = await Promise.all([
    supabase.rpc('get_admin_user_profile', { p_user_id: userId }),
    supabase.rpc('list_admin_roles'),
    supabase.rpc('list_user_effective_permissions', { p_user_id: userId }),
    supabase.rpc('list_admin_team', { p_search: null, p_role_name: null, p_status: null }),
  ]);

  if (userError) throw userError;
  if (roleError) throw roleError;
  if (permissionError) throw permissionError;
  if (teamError) throw teamError;

  const user = (userRows ?? [])[0];
  if (!user) notFound();

  const initials = String(user.full_name ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((item) => item[0]?.toUpperCase() ?? '')
    .join('');

  const roleOptions = (roleRows ?? []).map((item: Record<string, unknown>) => ({
    id: String(item.id),
    name: String(item.name),
  }));

  const permissions = (permissionRows ?? []).map((item: Record<string, unknown>) => ({
    code: String(item.code),
    module: String(item.module),
    name: String(item.name),
    state: String(item.state) === 'allow' ? 'allow' : String(item.state) === 'deny' ? 'deny' : 'inherit',
    origin: String(item.origin),
    isEffective: Boolean(item.is_effective),
  }));

  const copyUsers = (teamRows ?? [])
    .filter((item: Record<string, unknown>) => String(item.user_id) !== userId)
    .map((item: Record<string, unknown>) => ({
      userId: String(item.user_id),
      fullName: String(item.full_name ?? ''),
      email: String(item.email ?? ''),
    }));

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader
            title="Editar acesso da equipe"
            subtitle="Defina funcao base, status e overrides individuais"
            actions={<Link href="/configuracoes/equipe" className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Voltar para equipe</Link>}
          />

          <AdminSection title="Usuario selecionado" description="Contexto do membro e status atual">
            <div className="grid gap-3 md:grid-cols-[auto_1fr]">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/20 text-lg font-semibold text-emerald-200">
                {initials || '?'}
              </div>
              <div className="space-y-1 text-sm text-slate-300">
                <p><span className="text-slate-400">Nome:</span> {String(user.full_name ?? '')}</p>
                <p><span className="text-slate-400">E-mail:</span> {String(user.email ?? '')}</p>
                <p><span className="text-slate-400">Funcao base:</span> {String(user.role_name ?? 'Sem funcao')}</p>
                <p className="flex items-center gap-2"><span className="text-slate-400">Status:</span> {Boolean(user.is_active) ? <AdminStatusBadge status="confirmed" /> : <AdminStatusBadge status="cancelled" />}</p>
                <p><span className="text-slate-400">Ultimo acesso:</span> {user.last_access_at ? new Date(String(user.last_access_at)).toLocaleString('pt-BR') : '-'}</p>
                <p><span className="text-slate-400">Observacao interna:</span> {String(user.internal_note ?? '-')}</p>
              </div>
            </div>
          </AdminSection>

          {permissions.length === 0 ? (
            <AdminEmptyState title="Sem permissoes cadastradas" description="Verifique se a migration de RBAC foi aplicada no banco." />
          ) : (
            <TeamAccessEditor
              targetUserId={userId}
              initialRoleId={user.role_id ? String(user.role_id) : null}
              initialIsActive={Boolean(user.is_active)}
              initialInternalNote={String(user.internal_note ?? '')}
              permissions={permissions}
              roleOptions={roleOptions}
              copyUsers={copyUsers}
            />
          )}
        </div>
      </div>
    </main>
  );
}
