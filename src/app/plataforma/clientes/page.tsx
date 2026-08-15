import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { AdminPageHeader, AdminSection, AdminEmptyState } from '@/components/admin';
import type { OrganizationStatus } from '@/lib/organizations/types';

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  plan_code: string | null;
  created_at: string;
  member_count: number;
  event_count: number;
};

async function listOrganizations(): Promise<OrgRow[]> {
  const supabase = await createServerSupabaseClient();

  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, name, slug, status, plan_code, created_at')
    .order('created_at', { ascending: false });

  if (!orgs?.length) return [];

  const orgIds = orgs.map((o) => o.id);

  // Contagem de membros ativos por organização
  const { data: memberCounts } = await supabase
    .from('organization_members')
    .select('organization_id')
    .in('organization_id', orgIds)
    .eq('is_active', true);

  const memberMap = new Map<string, number>();
  for (const row of memberCounts ?? []) {
    memberMap.set(row.organization_id, (memberMap.get(row.organization_id) ?? 0) + 1);
  }

  // Contagem de eventos por organização (quando houver coluna organization_id em events)
  // Por enquanto retorna 0 — coluna ainda não foi adicionada nesta etapa.
  const eventMap = new Map<string, number>();

  return orgs.map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug,
    status: o.status as OrganizationStatus,
    plan_code: o.plan_code,
    created_at: o.created_at,
    member_count: memberMap.get(o.id) ?? 0,
    event_count: eventMap.get(o.id) ?? 0,
  }));
}

const statusLabel: Record<OrganizationStatus, string> = {
  active: 'Ativa',
  trial: 'Em teste',
  suspended: 'Suspensa',
  cancelled: 'Cancelada',
};

const statusClass: Record<OrganizationStatus, string> = {
  active:    'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
  trial:     'border-amber-500/40 bg-amber-500/15 text-amber-200',
  suspended: 'border-rose-500/40 bg-rose-500/15 text-rose-200',
  cancelled: 'border-slate-600 bg-slate-800/70 text-slate-300',
};

function OrgStatusBadge({ status }: { status: OrganizationStatus }) {
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass[status]}`}>
      {statusLabel[status]}
    </span>
  );
}

export default async function ClientesPage() {
  const orgs = await listOrganizations();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="border-b border-slate-800 bg-slate-900 px-6 py-4">
        <div className="flex items-center gap-4">
          <Link href="/plataforma" className="text-xs text-slate-400 hover:text-slate-200">
            ← Painel
          </Link>
          <div className="flex flex-col gap-0.5">
            <span className="text-lg font-bold tracking-tight text-white">NEXORA</span>
            <span className="text-xs text-slate-400">Administração da Plataforma</span>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        <AdminPageHeader
          title="Clientes"
          subtitle="Organizações cadastradas na plataforma."
        />

        <AdminSection title={`${orgs.length} organização${orgs.length !== 1 ? 'ões' : ''}`}>
          {orgs.length === 0 ? (
            <AdminEmptyState title="Sem organizações" description="Nenhuma organização cadastrada na plataforma ainda." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs uppercase tracking-widest text-slate-500">
                    <th className="py-2 pr-4 text-left font-medium">Nome</th>
                    <th className="py-2 pr-4 text-left font-medium">Status</th>
                    <th className="py-2 pr-4 text-left font-medium">Plano</th>
                    <th className="py-2 pr-4 text-left font-medium">Membros</th>
                    <th className="py-2 pr-4 text-left font-medium">Eventos</th>
                    <th className="py-2 text-left font-medium">Criada em</th>
                  </tr>
                </thead>
                <tbody>
                  {orgs.map((org) => (
                    <tr key={org.id} className="border-b border-slate-800/60 hover:bg-slate-900/40">
                      <td className="py-3 pr-4 font-medium text-slate-100">{org.name}</td>
                      <td className="py-3 pr-4">
                        <OrgStatusBadge status={org.status} />
                      </td>
                      <td className="py-3 pr-4 text-slate-400">{org.plan_code ?? '—'}</td>
                      <td className="py-3 pr-4 text-slate-300">{org.member_count}</td>
                      <td className="py-3 pr-4 text-slate-300">{org.event_count}</td>
                      <td className="py-3 text-slate-400">
                        {new Date(org.created_at).toLocaleDateString('pt-BR')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdminSection>
      </div>
    </div>
  );
}
