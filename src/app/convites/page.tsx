import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminEmptyState, AdminFilterBar, AdminStatCard } from "@/components/admin";
import { getCurrentPermissionMap } from "@/lib/admin/permissions";
import {
  INVITE_CENTER_PERMISSIONS,
  inviteCenterEmptyCopy,
} from "@/lib/invites/invite-center-status";
import { inviteCenterHref } from "@/lib/invites/invite-center-query";
import { loadInviteCenter } from "./actions";
import { InviteCenterBulkPanel } from "./invite-center-bulk";
import { InviteCenterFilters } from "./invite-center-filters";
import { InviteCenterList } from "./invite-center-list";

type Search = {
  eventId?: string;
  import_batch_id?: string;
  status?: string;
  shared?: string;
  q?: string;
  sort?: string;
  page?: string;
  pageSize?: string;
};

const emptyCounts = {
  total: 0, concluido: 0, pendente: 0, expirado: 0, falha: 0,
  cadastro_pendente: 0, admin_action: 0, nao_enviado: 0, pulado: 0, shared_groups: 0,
};

export default async function ConvitesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const permissionMap = await getCurrentPermissionMap([...INVITE_CENTER_PERMISSIONS]);
  const query = {
    eventId: params.eventId ?? null,
    importBatchId: params.import_batch_id ?? null,
    status: params.status ?? "all",
    shared: params.shared ?? "all",
    q: params.q ?? null,
    sort: params.sort ?? "attention",
    page: params.page ?? "1",
    pageSize: params.pageSize ?? "25",
  };
  const result = await loadInviteCenter(query);
  const payload = result.success ? result.data : null;
  const counts = payload?.counts ?? emptyCounts;
  const rows = payload?.rows ?? [];
  const pageSize = Number(payload?.page_size ?? query.pageSize ?? 25);
  const page = Number(payload?.page ?? query.page ?? 1);
  const filteredCount = Number(payload?.row_count ?? rows.length);
  const pageCount = Math.max(1, Math.ceil(filteredCount / pageSize));
  const completion = payload?.completion ?? { done: 0, total: 0, percent: 0 };
  const allCompleted = counts.total > 0 && counts.concluido === counts.total && counts.pendente === 0 && counts.expirado === 0 && counts.falha === 0 && counts.cadastro_pendente === 0 && counts.admin_action === 0;
  const empty = inviteCenterEmptyCopy(query.status ?? "all", rows.length > 0, allCompleted && (query.status === "all" || !query.status));
  const baseQuery = {
    eventId: query.eventId,
    importBatchId: query.importBatchId,
    shared: query.shared,
    q: query.q,
    sort: query.sort,
    pageSize: query.pageSize,
  };

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl gap-6">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-6">
          <TopBar
            title="Central de Convites"
            subtitle="Primeiro acesso"
            breadcrumbs={[{ label: "Início", href: "/painel" }, { label: "Convites" }]}
            fallbackHref="/painel"
          />

          {!result.success ? <p className="text-sm text-rose-200">{result.message}</p> : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <AdminStatCard compact label="Total" value={counts.total} href={inviteCenterHref({ ...baseQuery, status: "all" })} />
            <AdminStatCard compact label="Concluídos" value={counts.concluido} tone="success" href={inviteCenterHref({ ...baseQuery, status: "concluidos" })} />
            <AdminStatCard compact label="Pendentes" value={counts.pendente} href={inviteCenterHref({ ...baseQuery, status: "pendentes" })} />
            <AdminStatCard compact label="Expirados" value={counts.expirado} tone="warning" href={inviteCenterHref({ ...baseQuery, status: "expirados" })} />
            <AdminStatCard compact label="Com problema" value={counts.falha + counts.cadastro_pendente + counts.admin_action} tone={counts.falha + counts.admin_action > 0 ? "danger" : "default"} href={inviteCenterHref({ ...baseQuery, status: counts.admin_action ? "admin_action" : "falha" })} />
            <AdminStatCard compact label="E-mails compartilhados" value={counts.shared_groups} href={inviteCenterHref({ ...baseQuery, shared: "yes" })} />
          </div>

          <p className="text-sm text-slate-300">
            Primeiro acesso concluído: {completion.done} / {completion.total} · {completion.percent}%
            <span className="ml-2 text-slate-500">Enviado não significa concluído.</span>
          </p>

          <AdminFilterBar>
            <InviteCenterFilters
              eventId={query.eventId ?? undefined}
              importBatchId={query.importBatchId ?? undefined}
              status={query.status ?? "all"}
              shared={query.shared ?? "all"}
              q={query.q ?? ""}
              sort={query.sort ?? "attention"}
              pageSize={pageSize}
              events={payload?.events ?? []}
              importBatches={payload?.import_batches ?? []}
            />
          </AdminFilterBar>

          {permissionMap["invites.bulk_resend"] ? (
            <InviteCenterBulkPanel
              canBulkResend
              sentLast24h={payload?.sent_last_24h ?? 0}
              activeJob={payload?.active_job ?? null}
            />
          ) : null}

          {rows.length ? (
            <InviteCenterList rows={rows} canResend={Boolean(permissionMap["invites.resend"])} />
          ) : (
            <AdminEmptyState title={empty.title} description={empty.description} />
          )}

          {pageCount > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-400">
              <p>Página {page} de {pageCount} · {filteredCount} nesta lista · totais dos cards não mudam com a página</p>
              <div className="flex gap-2">
                {page > 1 ? <Link href={inviteCenterHref({ ...baseQuery, status: query.status, page: page - 1 })} className="rounded-lg border border-slate-700 px-3 py-1.5">Anterior</Link> : null}
                {page < pageCount ? <Link href={inviteCenterHref({ ...baseQuery, status: query.status, page: page + 1 })} className="rounded-lg border border-slate-700 px-3 py-1.5">Próxima</Link> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
