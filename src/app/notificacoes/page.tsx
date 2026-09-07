import { requireAdministrativePanelAccess } from "@/lib/admin/panel-access";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { listOrganizationNotificationsAction } from "./actions";
import { NotificationsInbox } from "./notifications-inbox";

export default async function NotificacoesPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string; tipo?: string; pagina?: string }>;
}) {
  await requireAdministrativePanelAccess();
  const params = await searchParams;
  const readState = params.filtro === "nao-lidas" ? "unread" : params.filtro === "lidas" ? "read" : "all";
  const type = params.tipo === "solicitacoes" ? "CHANGE_REQUEST_CREATED" : params.tipo === "feedbacks" ? "FEEDBACK_CREATED" : null;
  const page = Math.max(1, Number(params.pagina || 1) || 1);
  const pageSize = 20;
  const offset = (page - 1) * pageSize;

  const result = await listOrganizationNotificationsAction({
    readState,
    type,
    limit: pageSize,
    offset,
  });

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar
            title="Notificações"
            subtitle="Central de atenção da organização"
            breadcrumbs={[{ label: "Início", href: "/painel" }, { label: "Notificações" }]}
            fallbackHref="/painel"
          />
          <NotificationsInbox
            notifications={result.success ? result.notifications : []}
            totalCount={result.success ? result.totalCount : 0}
            readState={readState}
            typeFilter={params.tipo ?? "todas"}
            page={page}
            pageSize={pageSize}
            errorMessage={result.success ? null : result.message ?? "Não foi possível carregar as notificações."}
          />
        </div>
      </div>
    </main>
  );
}
