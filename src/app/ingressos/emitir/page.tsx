import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { hasPermission } from "@/lib/admin/permissions";
import { IssueTicketForm } from "./issue-ticket-form";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function IssueTicketPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const canIssue = await hasPermission("participants.create");
  if (!canIssue) redirect("/acesso-negado");

  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const org = (await getCurrentOrganizationContext()).organization;
  const requestedContactId = query.from === "cadastro" && query.contactId && uuid.test(query.contactId) ? query.contactId : null;
  const [{ data: events }, { data: initialContact }] = org?.id
    ? await Promise.all([
      supabase.from("events").select("id,name").eq("organization_id", org.id).eq("is_active", true).is("archived_at", null).order("starts_at", { ascending: false }),
      requestedContactId
        ? supabase.from("registration_contacts").select("id,full_name,public_pin").eq("id", requestedContactId).eq("organization_id", org.id).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    : [{ data: [] }, { data: null }];
  const contactContext = initialContact ? { id: String(initialContact.id), name: String(initialContact.full_name), pin: String(initialContact.public_pin ?? "") } : null;
  const cadastroHref = contactContext ? `/cadastros/${contactContext.id}` : "/cadastros";

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl gap-6">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Emitir ingresso" subtitle="Ingressos" breadcrumbs={contactContext ? [{label:"Início",href:"/painel"},{label:"Cadastros",href:"/cadastros"},{label:contactContext.name,href:cadastroHref},{label:"Emitir ingresso"}] : undefined} backHref={cadastroHref} fallbackHref={cadastroHref} />
          <SectionCard
            title="Emissão manual de ingresso"
            description="Gera sempre um ingresso novo e independente para o PIN de cadastro informado — cortesia, correção de falha do sistema ou outro motivo, sem passar por confirmação de pagamento."
          >
            <IssueTicketForm events={(events ?? []).map((e) => ({ id: String(e.id), name: String(e.name) }))} initialPin={contactContext?.pin ?? query.pin ?? ""} initialContact={contactContext} />
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
