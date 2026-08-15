import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { getCurrentPermissionMap, requireAnyPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { TicketOwnershipEditor } from "./ticket-ownership-editor";
import { appendNavigationContext, isSafeContextUuid } from "@/lib/navigation/admin-navigation";

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export default async function EditTicketOwnershipPage({ params, searchParams }: { params: Promise<{ ticketId: string }>; searchParams: Promise<{from?:string;contactId?:string}> }) {
  await requireAnyPermission(["participants.edit_basic", "orders.cancel", "tickets.transfer_ownership"]);
  const permissions = await getCurrentPermissionMap(["participants.edit_basic", "orders.cancel", "tickets.transfer_ownership"]);
  const { ticketId } = await params;
  const navigation = await searchParams;
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) redirect("/acesso-negado");

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("tickets")
    .select("id,token,status,used_at,organization_id,owner_user_id,participant_id,participants(full_name),orders(user_id),order_items(registration_contact_id,ticket_categories(name)),participant_kit_items(status)")
    .eq("id", ticketId)
    .eq("organization_id", organization.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) redirect("/acesso-negado");

  const holder = one(data.participants as { full_name: string } | { full_name: string }[] | null);
  const order = one(data.orders as { user_id: string | null } | { user_id: string | null }[] | null);
  const buyerResult = order?.user_id
    ? await supabase.from("customer_profiles").select("full_name").eq("user_id", order.user_id).maybeSingle()
    : null;
  const ownerResult = data.owner_user_id
    ? await supabase.from("customer_profiles").select("full_name").eq("user_id", data.owner_user_id).maybeSingle()
    : null;
  const kits = (data.participant_kit_items ?? []) as Array<{ status: string }>;
  const item = one(data.order_items as {registration_contact_id:string|null;ticket_categories:{name:string}|{name:string}[]|null}|Array<{registration_contact_id:string|null;ticket_categories:{name:string}|{name:string}[]|null}>|null);
  const category = one(item?.ticket_categories ?? null);
  const requestedContactId = navigation.from === "cadastro" && isSafeContextUuid(navigation.contactId) ? navigation.contactId : null;
  const ownerContactResult=requestedContactId&&data.owner_user_id?await supabase.from("participants").select("id").eq("organization_id",organization.id).eq("registration_contact_id",requestedContactId).eq("user_id",data.owner_user_id).limit(1):null;
  const fromCadastro = Boolean(requestedContactId && (requestedContactId === item?.registration_contact_id || ownerContactResult?.data?.length));
  const contactResult = fromCadastro ? await supabase.from("registration_contacts").select("full_name").eq("id",requestedContactId).eq("organization_id",organization.id).maybeSingle() : null;
  const ticketLabel = `#${String(data.token ?? data.id).slice(0,8).toUpperCase()}${category?.name ? ` / ${category.name}` : ""}`;
  const context = fromCadastro ? {from:"cadastro",contactId:requestedContactId!} : {};
  const detailHref = appendNavigationContext(`/ingressos/${ticketId}`,context);
  const breadcrumbs = fromCadastro ? [{label:"Início",href:"/painel"},{label:"Cadastros",href:"/cadastros"},{label:String(contactResult?.data?.full_name ?? "Cadastro"),href:`/cadastros/${requestedContactId}`},{label:ticketLabel,href:detailHref},{label:"Editar ingresso"}] : [{label:"Início",href:"/painel"},{label:"Ingressos",href:"/ingressos"},{label:ticketLabel,href:detailHref},{label:"Editar ingresso"}];

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl gap-6">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-6">
          <TopBar title="Editar ingresso" subtitle="Titularidade operacional e cancelamento" breadcrumbs={breadcrumbs} backHref={detailHref} fallbackHref="/ingressos" />
          <TicketOwnershipEditor
            ticketId={ticketId}
            currentHolder={holder?.full_name ?? "Titular não definido"}
            buyer={buyerResult?.data?.full_name ?? "Comprador não identificado"}
            currentOwner={ownerResult?.data?.full_name ?? (data.owner_user_id ? "Conta NEXORA" : "Proprietário não definido")}
            currentOwnerUserId={data.owner_user_id ? String(data.owner_user_id) : null}
            status={data.status}
            canTransfer={permissions["participants.edit_basic"]}
            canTransferOwnership={permissions["tickets.transfer_ownership"]}
            canCancel={permissions["orders.cancel"]}
            blockedByCheckin={Boolean(data.used_at) || data.status === "used"}
            blockedByDelivery={kits.some((item) => item.status === "delivered")}
          />
        </div>
      </div>
    </main>
  );
}
