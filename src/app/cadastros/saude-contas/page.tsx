import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminEmptyState, AdminFilterBar, AdminStatCard } from "@/components/admin";
import {
  accountHealthConfirmedWithoutContactCount,
  accountHealthHref,
  accountHealthNoAccountCount,
  parseAccountHealthFilter,
} from "@/lib/account/account-health";
import { loadAccountHealth } from "./actions";
import { AccountHealthFilters } from "./health-filters";
import { AccountHealthList } from "./health-list";

type Search = {
  estado?: string;
  q?: string;
  page?: string;
  pageSize?: string;
};

const emptyCounts = {
  total: 0,
  healthy: 0,
  pending_confirmation: 0,
  no_account: 0,
  confirmed_unlinked: 0,
  email_divergent: 0,
  attention: 0,
  auth_without_contact: 0,
  auth_without_contact_confirmed: 0,
  possible_orphan: 0,
  possible_orphan_confirmed: 0,
  possible_orphan_unconfirmed: 0,
  reviewed_without_account: 0,
};

export default async function AccountHealthPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const result = await loadAccountHealth({
    state: params.estado ?? null,
    q: params.q ?? null,
    page: params.page ?? "1",
    pageSize: params.pageSize ?? "25",
  });
  const payload = result.success ? result.data : null;
  const canViewOrphans = Boolean(payload?.can_view_orphans);
  const query = {
    state: parseAccountHealthFilter(params.estado, canViewOrphans),
    q: params.q ?? null,
    page: params.page ?? "1",
    pageSize: params.pageSize ?? "25",
  };
  const counts = payload?.counts ?? emptyCounts;
  const rows = payload?.rows ?? [];
  const pageSize = Number(payload?.page_size ?? query.pageSize ?? 25);
  const page = Number(payload?.page ?? query.page ?? 1);
  const filteredCount = Number(payload?.row_count ?? rows.length);
  const pageCount = Math.max(1, Math.ceil(filteredCount / pageSize));
  const baseQuery = { q: query.q, pageSize: query.pageSize };

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl gap-6">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-6">
          <TopBar
            title="Saúde de contas"
            subtitle="Diagnóstico de Cadastro, Conta e participação"
            breadcrumbs={[{ label: "Início", href: "/painel" }, { label: "Cadastros", href: "/cadastros" }, { label: "Saúde de contas" }]}
            fallbackHref="/cadastros"
          />

          {!result.success ? <p className="text-sm text-rose-200">{result.message}</p> : null}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <AdminStatCard compact label="Saudáveis" value={counts.healthy} tone="success" href={accountHealthHref({ ...baseQuery, state: "healthy" })} />
            <AdminStatCard compact label="Aguardando confirmação" value={counts.pending_confirmation} tone="warning" href={accountHealthHref({ ...baseQuery, state: "pending_confirmation" })} />
            <AdminStatCard compact label="Sem conta" value={accountHealthNoAccountCount(counts)} href={accountHealthHref({ ...baseQuery, state: "no_account" })} />
            <AdminStatCard compact label="Revisados" value={counts.reviewed_without_account} tone="success" href={accountHealthHref({ ...baseQuery, state: "reviewed_without_account" })} />
            <AdminStatCard compact label="Requer atenção" value={counts.attention} tone="danger" href={accountHealthHref({ ...baseQuery, state: "attention" })} />
          </div>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-slate-300">Diagnósticos</h2>
            <div className="flex flex-wrap gap-2">
              <Link href={accountHealthHref({ ...baseQuery, state: "auth_without_contact" })} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-300 hover:border-emerald-400/50">
                <span className="text-slate-400">Conta sem cadastro</span>
                <span className="font-semibold text-white">{counts.auth_without_contact}</span>
              </Link>
              <Link href={accountHealthHref({ ...baseQuery, state: "email_divergent" })} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-300 hover:border-emerald-400/50">
                <span className="text-slate-400">E-mail divergente</span>
                <span className="font-semibold text-white">{counts.email_divergent}</span>
              </Link>
              {canViewOrphans ? (
                <Link href={accountHealthHref({ ...baseQuery, state: "possible_orphan" })} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-300 hover:border-emerald-400/50">
                  <span className="text-slate-400">Possível órfã</span>
                  <span className="font-semibold text-white">{counts.possible_orphan}</span>
                </Link>
              ) : null}
              <Link href={accountHealthHref({ ...baseQuery, state: "no_account" })} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-300 hover:border-emerald-400/50">
                <span className="text-slate-400">Confirmada sem cadastro</span>
                <span className="font-semibold text-white">{accountHealthConfirmedWithoutContactCount(counts)}</span>
              </Link>
            </div>
          </section>

          <AdminFilterBar>
            <AccountHealthFilters state={query.state} q={query.q ?? ""} pageSize={pageSize} canViewOrphans={canViewOrphans} />
          </AdminFilterBar>

          {rows.length === 0 ? (
            <AdminEmptyState
              title={query.state === "all" && !query.q ? "Nenhum caso neste universo" : "Nenhum caso neste filtro"}
              description="A busca fica restrita às pessoas e contas desta organização. Nada é transferido nem mesclado daqui."
            />
          ) : (
            <AccountHealthList rows={rows} />
          )}

          {pageCount > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400">
              <p>{filteredCount} caso(s) · página {page} de {pageCount}</p>
              <div className="flex gap-2">
                {page > 1 ? <Link href={accountHealthHref({ ...baseQuery, state: query.state, page: page - 1 })} className="inline-flex h-11 items-center rounded-xl border border-slate-700 px-4">Anterior</Link> : null}
                {page < pageCount ? <Link href={accountHealthHref({ ...baseQuery, state: query.state, page: page + 1 })} className="inline-flex h-11 items-center rounded-xl border border-slate-700 px-4">Próxima</Link> : null}
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">{filteredCount} caso(s)</p>
          )}
        </div>
      </div>
    </main>
  );
}
