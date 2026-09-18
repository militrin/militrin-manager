import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { hasPermission, requireAnyPermission } from "@/lib/admin/permissions";
import { getAdministrativeTicketTimeline } from "@/lib/admin/ticket-timeline";
import TicketDetailPage from "@/app/minha-conta/ingressos/[ticketId]/page";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdministrativeTicketTimeline } from "./timeline-panel";
import { TicketCancellationRegularization } from "./cancellation-regularization";
import { appendNavigationContext, isSafeContextUuid } from "@/lib/navigation/admin-navigation";
import { sanitizeAdminTicketsReturnTo } from "@/lib/admin/admin-ticket-filters";
import { resolveLinkedAccountLabel } from "@/lib/admin/operator-names";
import { ChangeTicketAccountOwnerCard } from "./change-ticket-account-owner";
import { canonicalHolderName } from "@/lib/tickets/holder-name";
import { canonicalTicketDisplayCode } from "@/lib/display-reference";
import { CopyableId } from "@/components/CopyableId";
import { buildTicketIdentityView } from "@/lib/registrations/contact-tickets";

type Search = { from?: string; to?: string; type?: string; scope?: "ticket" | "account"; eventId?: string; page?: string; contactId?: string; returnTo?: string };

export default async function AdministrativeTicketDetailPage({ params, searchParams }: { params: Promise<{ ticketId: string }>; searchParams: Promise<Search> }) {
  await requireAnyPermission(["participants.view", "orders.view"]);
  const resolved = await params; const filters = await searchParams;
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) redirect("/acesso-negado");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("tickets").select("id,token,organization_id,event_id,owner_user_id,intended_owner_contact_id,order_id,status,cancellation_replacement_required,cancellation_reason_text,events(name),orders(display_number,order_number),order_items(registration_contact_id,holder_full_name,item_position,ticket_categories(name)),participants(registration_contact_id,full_name)").eq("id", resolved.ticketId).eq("organization_id", organization.id).maybeSingle();
  if (error) throw error; if (!data) redirect("/acesso-negado");
  const orderItem = Array.isArray(data.order_items) ? data.order_items[0] : data.order_items;
  const order = Array.isArray(data.orders) ? data.orders[0] : data.orders;
  const event = Array.isArray(data.events) ? data.events[0] : data.events;
  const participant = Array.isArray(data.participants) ? data.participants[0] : data.participants;
  const contactId = orderItem?.registration_contact_id ?? participant?.registration_contact_id ?? null;
  const requestedContactId = filters.from === "cadastro" && isSafeContextUuid(filters.contactId) ? filters.contactId : null;
  const ownerContactResult=requestedContactId&&data.owner_user_id?await supabase.from("participants").select("id").eq("organization_id",organization.id).eq("registration_contact_id",requestedContactId).eq("user_id",data.owner_user_id).limit(1):null;
  const fromCadastro = Boolean(requestedContactId && (requestedContactId === contactId || ownerContactResult?.data?.length));
  const contactResult = fromCadastro ? await supabase.from("registration_contacts").select("full_name").eq("id", requestedContactId).eq("organization_id", organization.id).maybeSingle() : null;
  const category = Array.isArray(orderItem?.ticket_categories) ? orderItem.ticket_categories[0] : orderItem?.ticket_categories;
  const eventName = event?.name;
  const ticketCode = canonicalTicketDisplayCode(order?.display_number, orderItem?.item_position, order?.order_number);
  const ticketLabel = `${ticketCode ?? "Ingresso"}${category?.name ? ` / ${category.name}` : ""}`;
  const navigationContext = fromCadastro ? {from:"cadastro" as const, contactId:requestedContactId!} : {};
  const listHref = fromCadastro ? `/cadastros/${requestedContactId}` : sanitizeAdminTicketsReturnTo(filters.returnTo);
  const editHref = appendNavigationContext(`/ingressos/${resolved.ticketId}/editar`,navigationContext);
  const breadcrumbs = fromCadastro ? [{label:"Início",href:"/painel"},{label:"Cadastros",href:"/cadastros"},{label:String(contactResult?.data?.full_name ?? "Cadastro"),href:`/cadastros/${requestedContactId}`},{label:ticketLabel}] : [{label:"Início",href:"/painel"},{label:"Ingressos",href:listHref},{label:ticketLabel}];
  const canViewTechnicalAudit = await hasPermission("audit.view");
  // Mesma regra ja auditada e publicada em owner_cancel_ticket (acesso a
  // organizacao + Owner OU orders.cancel) -- current_user_has_permission ja
  // resolve Owner como concedido pra qualquer permissao (resolve_user_permission),
  // entao uma unica checagem aqui ja cobre os dois casos.
  const canRegularizeCancellation = await hasPermission("orders.cancel");
  const timeline = await getAdministrativeTicketTimeline(supabase, resolved.ticketId, organization.id, { from:filters.from,to:filters.to,type:filters.type,scope:filters.scope,eventId:filters.eventId,page:Number(filters.page??1),pageSize:25,canViewTechnicalAudit });
  const canManageAccountOwner = await hasPermission("participants.edit_basic") || await hasPermission("tickets.transfer_ownership");
  const holderName = canonicalHolderName(orderItem?.holder_full_name, participant?.full_name);
  const holderContactId = orderItem?.registration_contact_id
    ? String(orderItem.registration_contact_id)
    : participant?.registration_contact_id
      ? String(participant.registration_contact_id)
      : null;
  const intendedOwnerContactId = data.intended_owner_contact_id ? String(data.intended_owner_contact_id) : null;
  const identityContactIds = Array.from(new Set([holderContactId, intendedOwnerContactId].filter((value): value is string => Boolean(value))));
  const { data: identityContacts, error: identityContactsError } = identityContactIds.length
    ? await supabase.from("registration_contacts").select("id,full_name,user_id").eq("organization_id", organization.id).in("id", identityContactIds)
    : { data: [] as Array<{ id: string; full_name?: string | null; user_id?: string | null }>, error: null };
  if (identityContactsError) throw identityContactsError;
  const identityContactsById = new Map((identityContacts ?? []).map((row) => [String(row.id), row]));
  const holderContact = holderContactId ? identityContactsById.get(holderContactId) : null;
  const intendedContact = intendedOwnerContactId ? identityContactsById.get(intendedOwnerContactId) : null;
  const holderContactUserId = holderContact?.user_id ? String(holderContact.user_id) : null;
  let holderInviteStatus: string | null = null;
  if (!holderContactUserId && holderContactId) {
    const { data: holderInvite, error: holderInviteError } = await supabase.from("participant_account_invites")
      .select("status")
      .eq("registration_contact_id", holderContactId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (holderInviteError) throw holderInviteError;
    holderInviteStatus = holderInvite?.status ? String(holderInvite.status) : null;
  }
  const identity = buildTicketIdentityView({
    holderName,
    holderContactUserId,
    holderInviteStatus,
    ownerUserId: data.owner_user_id ? String(data.owner_user_id) : null,
    ownerName: data.owner_user_id ? await resolveLinkedAccountLabel(String(data.owner_user_id)) : null,
    intendedOwnerContactId,
    intendedOwnerName: intendedContact?.full_name ? String(intendedContact.full_name) : null,
    ticketStatus: String(data.status ?? ""),
  });
  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100"><div className="mx-auto flex max-w-7xl gap-6"><Sidebar/><div className="min-w-0 flex-1 space-y-6"><TopBar title="Ficha administrativa do ingresso" subtitle={ticketLabel} breadcrumbs={breadcrumbs} backHref={listHref} fallbackHref="/ingressos"/>{ticketCode ? <CopyableId label="Código do ingresso" value={ticketCode} /> : null}<ChangeTicketAccountOwnerCard ticketId={resolved.ticketId} ticketCode={ticketCode} eventName={String(eventName ?? "Evento")} identity={identity} canManage={canManageAccountOwner}/><TicketDetailPage params={Promise.resolve(resolved)} showTimeline={false} adminEditHref={editHref}/><TicketCancellationRegularization ticketId={resolved.ticketId} status={String(data.status ?? "")} replacementRequired={data.cancellation_replacement_required as boolean | null} reasonText={data.cancellation_reason_text as string | null} canRegularize={canRegularizeCancellation}/><AdministrativeTicketTimeline result={timeline} filters={{...filters,from:filters.from}}/></div></div></main>;
}
