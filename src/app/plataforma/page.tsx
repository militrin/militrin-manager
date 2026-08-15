import { createServerSupabaseClient } from '@/lib/supabase/server';
import { AdminPageHeader, AdminSection, AdminStatCard } from '@/components/admin';

type OrgStatusCount = {
  active: number;
  trial: number;
  suspended: number;
  cancelled: number;
};

async function getOrgStats(): Promise<OrgStatusCount> {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from('organizations')
    .select('status');

  const rows = data ?? [];
  return {
    active:    rows.filter((r) => r.status === 'active').length,
    trial:     rows.filter((r) => r.status === 'trial').length,
    suspended: rows.filter((r) => r.status === 'suspended').length,
    cancelled: rows.filter((r) => r.status === 'cancelled').length,
  };
}

export default async function PlataformaPage() {
  const stats = await getOrgStats();
  const total = stats.active + stats.trial + stats.suspended + stats.cancelled;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="border-b border-slate-800 bg-slate-900 px-6 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-lg font-bold tracking-tight text-white">NEXORA</span>
          <span className="text-xs text-slate-400">Administração da Plataforma</span>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        <AdminPageHeader
          title="Visão Geral"
          subtitle="Status consolidado das organizações cadastradas na plataforma."
        />

        <AdminSection title="Organizações">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <AdminStatCard label="Total" value={total} />
            <AdminStatCard label="Ativas" value={stats.active} />
            <AdminStatCard label="Em teste" value={stats.trial} />
            <AdminStatCard label="Suspensas" value={stats.suspended} />
          </div>
        </AdminSection>
      </div>
    </div>
  );
}
