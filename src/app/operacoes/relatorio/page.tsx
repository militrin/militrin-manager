import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminPageHeader } from "@/components/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { pickDefaultEvent } from "@/lib/operations/history/period";
import { queryOperationsHistory } from "@/lib/operations/history/query";
import { parseHistorySearchParams } from "@/lib/operations/history/url";
import { OperationsHistoryClient } from "./operations-history-client";

export default async function OperacoesRelatorioPage({
  searchParams,
}: {
  searchParams: Promise<{
    eventId?: string;
    period?: string;
    dateFrom?: string;
    dateTo?: string;
    category?: string;
    operatorUserId?: string;
    search?: string;
    shirtType?: string;
    shirtSize?: string;
  }>;
}) {
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) {
    return <main className="p-8 text-slate-200">Selecione uma organização para visualizar o histórico.</main>;
  }

  const params = await searchParams;
  const parsed = parseHistorySearchParams(params);
  const supabase = await createServerSupabaseClient();
  const { data: events } = await supabase
    .from("events")
    .select("id,name,starts_at,ends_at")
    .eq("organization_id", organization.id)
    .order("starts_at", { ascending: false });

  const eventOptions = (events ?? []).map((event) => ({
    id: String(event.id),
    name: String(event.name),
    starts_at: event.starts_at ? String(event.starts_at) : null,
    ends_at: event.ends_at ? String(event.ends_at) : null,
  }));
  const requested = eventOptions.find((event) => event.id === (parsed.eventId ?? params.eventId));
  const selected = requested ?? pickDefaultEvent(eventOptions);
  const initialResult = selected
    ? await queryOperationsHistory({
        eventId: selected.id,
        period: parsed.period,
        dateFrom: parsed.dateFrom,
        dateTo: parsed.dateTo,
        category: parsed.category,
        operatorUserId: parsed.operatorUserId,
        search: parsed.search,
        shirtType: parsed.shirtType,
        shirtSize: parsed.shirtSize,
      })
    : { success: false as const, message: "Nenhum evento encontrado nesta organização." };

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <div className="min-w-0 flex-1 flex-col overflow-x-hidden">
        <div className="hidden lg:block">
          <TopBar
            title="Histórico de Operações"
            subtitle={organization.name}
            breadcrumbs={[
              { label: "Início", href: "/painel" },
              { label: "Operações", href: "/operacoes" },
              { label: "Histórico de Operações" },
            ]}
          />
        </div>
        <main className="mx-auto w-full max-w-7xl space-y-3 overflow-x-hidden px-3 lg:space-y-5 lg:px-6 lg:py-6">
          <div className="hidden lg:block">
            <AdminPageHeader
              compact
              title="Histórico de Operações"
              subtitle="Acompanhe as operações realizadas no evento e identifique rapidamente alterações, correções e responsáveis."
            />
          </div>
          {eventOptions.length === 0 || !selected ? (
            <p className="text-sm text-slate-300">Nenhum evento disponível nesta organização.</p>
          ) : (
            <OperationsHistoryClient
              events={eventOptions.map((event) => ({ id: event.id, name: event.name }))}
              initialEventId={selected.id}
              initialQuery={parsed}
              initialResult={initialResult}
            />
          )}
        </main>
      </div>
    </div>
  );
}
