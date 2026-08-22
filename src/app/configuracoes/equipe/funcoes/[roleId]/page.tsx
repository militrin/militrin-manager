import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { AdminPageHeader, AdminSection } from '@/components/admin';
import { requirePermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { RolePermissionsEditor } from './role-permissions-editor';

export default async function RolePermissionsPage({ params }: { params: Promise<{ roleId: string }> }) {
  await requirePermission('team.edit_permissions');

  const { roleId } = await params;
  const supabase = await createServerSupabaseClient();

  const [{ data: roleRows, error: roleError }, { data: permissionRows, error: permissionError }] = await Promise.all([
    supabase.rpc('list_admin_roles'),
    supabase.rpc('list_admin_role_permissions', { p_role_id: roleId }),
  ]);

  if (roleError) throw roleError;
  if (permissionError) throw permissionError;

  const role = (roleRows ?? []).find((item: Record<string, unknown>) => String(item.id) === roleId);
  if (!role) notFound();

  const permissions = (permissionRows ?? []).map((item: Record<string, unknown>) => ({
    code: String(item.code),
    module: String(item.module),
    name: String(item.name),
    description: item.description ? String(item.description) : null,
    hasPermission: Boolean(item.has_permission),
    isSystemDefault: Boolean(item.is_system_default),
  }));

  // Mesmo padrao preventivo ja usado em [userId]/page.tsx (isLastActiveOwner):
  // list_admin_roles nao expoe "code", entao a UI reconhece Owner pelo nome,
  // igual ao editor individual ja faz. A protecao REAL e no RPC
  // (upsert_admin_role_permissions rejeita code='owner' incondicionalmente).
  const isOwnerRole = String(role.name ?? '') === 'Owner';

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader
            title={`Permissões da função: ${String(role.name)}`}
            subtitle="Defina quais permissões esta função concede por padrão -- afeta imediatamente todos os usuários que herdarem dela."
            actions={
              <Link href="/painel/configuracoes/equipe?tab=roles" className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">
                Voltar para funções
              </Link>
            }
            breadcrumbs={[
              { label: 'Início', href: '/painel' },
              { label: 'Configurações', href: '/configuracao' },
              { label: 'Equipe', href: '/painel/configuracoes/equipe' },
              { label: 'Funções e permissões', href: '/painel/configuracoes/equipe?tab=roles' },
              { label: String(role.name) },
            ]}
            backHref="/painel/configuracoes/equipe?tab=roles"
          />

          {isOwnerRole ? (
            <AdminSection title="Owner" description="Função de sistema, sempre com acesso total">
              <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                Owner possui acesso total e não pode ser limitado. Esta função sempre ignora a lista de permissões abaixo -- não há nada para editar aqui.
              </p>
            </AdminSection>
          ) : permissions.length === 0 ? (
            <AdminSection title="Permissões" description="Nenhuma permissão cadastrada">
              <p className="text-sm text-slate-400">Verifique se as migrations de RBAC foram aplicadas no banco.</p>
            </AdminSection>
          ) : (
            <RolePermissionsEditor roleId={roleId} roleName={String(role.name)} permissions={permissions} />
          )}
        </div>
      </div>
    </main>
  );
}
