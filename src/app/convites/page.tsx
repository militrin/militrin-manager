import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminEmptyState, AdminFilterBar, AdminStatCard } from "@/components/admin";
import { getCurrentPermissionMap } from "@/lib/admin/permissions";
import {
  INVITE_CENTER_CARD_HELP,
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

function InviteCenterSecondaryStat({
  label,
  value,
  href,
  emphasize = false,
}: {
  label: string;
  value: number;
  href: string;
  emphasize?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-sm transition hover:border-emerald-400/50 ${
        emphasize ? "border-rose-500/40 bg-rose-500/10 text-rose-100" : "border-slate-800 bg-slate-950/40 text-slate-300"
      }`}
    >
      <span className={emphasize ? "text-rose-200" : "text-slate-400"}>{label}</span>
      <span className="font-semibold text-white">{value}</span>
      <span className="text-[11px] font-semibold text-emerald-300">Ver detalhes →</span>
    </Link>
  );
}

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
  const problemCount = counts.falha + counts.admin_action;
  const completionPercent = Math.max(0, Math.min(100, Number(completion.percent) || 0));

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

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <AdminStatCard compact label="Total" value={counts.total} href={inviteCenterHref({ ...baseQuery, status: "all" })} />
            <AdminStatCard compact label="Concluídos" value={counts.concluido} tone="success" href={inviteCenterHref({ ...baseQuery, status: "concluidos" })} />
            <AdminStatCard compact label="Aguardando acesso" value={counts.pendente} tooltip={INVITE_CENTER_CARD_HELP.pendente} href={inviteCenterHref({ ...baseQuery, status: "pendentes" })} />
            <AdminStatCard compact label="Cadastro incompleto" value={counts.cadastro_pendente} tone="warning" tooltip={INVITE_CENTER_CARD_HELP.cadastro_pendente} href={inviteCenterHref({ ...baseQuery, status: "cadastro_pendente" })} />
            <AdminStatCard compact label="Links expirados" value={counts.expirado} tone="warning" tooltip={INVITE_CENTER_CARD_HELP.expirado} href={inviteCenterHref({ ...baseQuery, status: "expirados" })} />
          </div>

          <div className="flex flex-wrap gap-2">
            <InviteCenterSecondaryStat
              label="E-mails compartilhados"
              value={counts.shared_groups}
              href={inviteCenterHref({ ...baseQuery, shared: "yes" })}
            />
            <InviteCenterSecondaryStat
              label="Ação necessária"
              value={problemCount}
              emphasize={problemCount > 0}
              href={inviteCenterHref({ ...baseQuery, status: counts.admin_action ? "admin_action" : "falha" })}
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm text-slate-300">
              Primeiro acesso concluído: {completion.done} / {completion.total} · {completion.percent}%
              <span className="ml-2 text-slate-500">Enviado não significa concluído.</span>
            </p>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completionPercent} aria-label="Primeiro acesso concluído">
              <div className="h-full rounded-full bg-emerald-400" style={{ width: `${completionPercent}%` }} />
            </div>
          </div>

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
