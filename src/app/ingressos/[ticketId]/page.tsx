import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { hasPermission, requireAnyPermission } from "@/lib/admin/permissions";
import { getAdministrativeTicketTimeline } from "@/lib/admin/ticket-timeline";
import TicketDetailPage from "@/app/minha-conta/ingressos/[ticketId]/page";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdministrativeTicketTimeline } from "./timeline-panel";
import { appendNavigationContext, isSafeContextUuid } from "@/lib/navigation/admin-navigation";

type Search = { from?: string; to?: string; type?: string; scope?: "ticket" | "account"; eventId?: string; page?: string; contactId?: string };

export default async function AdministrativeTicketDetailPage({ params, searchParams }: { params: Promise<{ ticketId: string }>; searchParams: Promise<Search> }) {
  await requireAnyPermission(["participants.view", "orders.view"]);
  const resolved = await params; const filters = await searchParams;
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) redirect("/acesso-negado");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("tickets").select("id,token,organization_id,event_id,owner_user_id,order_id,order_items(registration_contact_id,ticket_categories(name)),participants(registration_contact_id)").eq("id", resolved.ticketId).eq("organization_id", organization.id).maybeSingle();
  if (error) throw error; if (!data) redirect("/acesso-negado");
  const orderItem = Array.isArray(data.order_items) ? data.order_items[0] : data.order_items;
  const participant = Array.isArray(data.participants) ? data.participants[0] : data.participants;
  const contactId = orderItem?.registration_contact_id ?? participant?.registration_contact_id ?? null;
  const requestedContactId = filters.from === "cadastro" && isSafeContextUuid(filters.contactId) ? filters.contactId : null;
  const ownerContactResult=requestedContactId&&data.owner_user_id?await supabase.from("participants").select("id").eq("organization_id",organization.id).eq("registration_contact_id",requestedContactId).eq("user_id",data.owner_user_id).limit(1):null;
  const fromCadastro = Boolean(requestedContactId && (requestedContactId === contactId || ownerContactResult?.data?.length));
  const contactResult = fromCadastro ? await supabase.from("registration_contacts").select("full_name").eq("id", requestedContactId).eq("organization_id", organization.id).maybeSingle() : null;
  const category = Array.isArray(orderItem?.ticket_categories) ? orderItem.ticket_categories[0] : orderItem?.ticket_categories;
  const ticketLabel = `#${String(data.token ?? data.id).slice(0,8).toUpperCase()}${category?.name ? ` / ${category.name}` : ""}`;
  const navigationContext = fromCadastro ? {from:"cadastro",contactId:requestedContactId!} : {};
  const editHref = appendNavigationContext(`/ingressos/${resolved.ticketId}/editar`,navigationContext);
  const breadcrumbs = fromCadastro ? [{label:"Início",href:"/painel"},{label:"Cadastros",href:"/cadastros"},{label:String(contactResult?.data?.full_name ?? "Cadastro"),href:`/cadastros/${requestedContactId}`},{label:ticketLabel}] : [{label:"Início",href:"/painel"},{label:"Ingressos",href:"/ingressos"},{label:ticketLabel}];
  const canViewTechnicalAudit = await hasPermission("audit.view");
  const timeline = await getAdministrativeTicketTimeline(supabase, resolved.ticketId, organization.id, { from:filters.from,to:filters.to,type:filters.type,scope:filters.scope,eventId:filters.eventId,page:Number(filters.page??1),pageSize:25,canViewTechnicalAudit });
  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100"><div className="mx-auto flex max-w-7xl gap-6"><Sidebar/><div className="min-w-0 flex-1 space-y-6"><TopBar title="Ficha administrativa do ingresso" subtitle={ticketLabel} breadcrumbs={breadcrumbs} backHref={fromCadastro ? `/cadastros/${requestedContactId}` : "/ingressos"} fallbackHref="/ingressos"/><TicketDetailPage params={Promise.resolve(resolved)} showTimeline={false} adminEditHref={editHref}/><AdministrativeTicketTimeline result={timeline} filters={{...filters,from:filters.from}}/></div></div></main>;
}
