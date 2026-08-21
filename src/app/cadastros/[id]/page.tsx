import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { CopyableId } from "@/components/CopyableId";
import { hasPermission, requireAnyPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { contactTicketRoleLabel, groupContactTickets, rolesForContactTicket } from "@/lib/registrations/contact-tickets";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ContactGrantStoreItemButton } from "../contact-store-items";

function relation(value: unknown) {
  return (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
}

function valueOrFallback(value: unknown, fallback = "Não informado") {
  return value ? String(value) : fallback;
}

export default async function CadastroDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAnyPermission(["participants.view", "orders.view"]);
  const { id } = await params;
  const supabase = await createServerSupabaseClient();
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) notFound();

  const [{ data: contact, error: contactError }, { data: ticketRows, error: ticketsError }, { data: linkedParticipants, error: participantsError }, { data: eventRows, error: eventsError }, { data: additionalOrderRows, error: additionalItemsError }, canIssueTicket, grantPermissions] = await Promise.all([
    supabase.from("registration_contacts").select("id,full_name,cpf,birth_date,gender,phone,email,city,created_at,public_pin").eq("id", id).eq("organization_id", organization.id).maybeSingle(),
    supabase.from("tickets").select("id,token,status,issued_at,used_at,event_id,owner_user_id,participant_id,order_id,order_item_id,events(id,name,starts_at),orders(order_number,status),order_items(participant_id,registration_contact_id,holder_full_name,shirt_type,shirt_size,ticket_categories(name),registration_batches(name)),participants(registration_contact_id,full_name),participant_kit_items(status)").eq("organization_id", organization.id).range(0, 4999),
    supabase.from("participants").select("id,user_id,registration_contact_id,participation_history(source)").eq("registration_contact_id", id).eq("organization_id", organization.id).range(0, 4999),
    supabase.from("events").select("id,name,starts_at").eq("organization_id", organization.id).order("starts_at", { ascending: false }),
    supabase.from("store_orders").select("id,event_id,payment_method,created_at,events(name),store_order_items(id,quantity,status,delivered_at,store_items(name),store_item_variants(name,value))").eq("organization_id", organization.id).eq("registration_contact_id", id).neq("status", "cancelled").order("created_at", { ascending: false }),
    hasPermission("participants.create"),
    Promise.all([hasPermission("store.grant_items"), hasPermission("store.manage")]),
  ]);
  if (contactError) throw contactError;
  if (!contact) notFound();
  if (ticketsError) throw ticketsError;
  if (participantsError) throw participantsError;
  if (eventsError) throw eventsError;
  if (additionalItemsError) throw additionalItemsError;
  const canGrantStoreItems = grantPermissions.some(Boolean);
  const accountIds = Array.from(new Set((linkedParticipants ?? []).flatMap((row) => row.user_id ? [String(row.user_id)] : [])));
  const linkedAccountIds = new Set(accountIds);

  const tickets = (ticketRows ?? []).flatMap((row) => {
    const orderItem = relation(row.order_items);
    const participant = relation(row.participants);
    const event = relation(row.events);
    const link = {
      ticketId: String(row.id), eventId: String(row.event_id), eventName: String(event?.name ?? "Evento"),
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
      orderItemContactId: orderItem?.registration_contact_id ? String(orderItem.registration_contact_id) : null,
      participantContactId: participant?.registration_contact_id ? String(participant.registration_contact_id) : null,
    };
    const roles = rolesForContactTicket(link,id,linkedAccountIds);
    if (roles.length===0) return [];
    const order = relation(row.orders);
    const category = relation(orderItem?.ticket_categories);
    const batch = relation(orderItem?.registration_batches);
    const kitItems = (Array.isArray(row.participant_kit_items) ? row.participant_kit_items : []) as Array<{ status?: string | null }>;
    return [{
      ticketId: String(row.id), eventId: String(row.event_id), eventName: String(event?.name ?? "Evento"),
      participantContactId: participant?.registration_contact_id ? String(participant.registration_contact_id) : null,
      orderItemContactId: orderItem?.registration_contact_id ? String(orderItem.registration_contact_id) : null,
      ownerUserId: link.ownerUserId, roles, roleLabel: contactTicketRoleLabel(roles),
      status: String(row.status ?? "pending"), issuedAt: row.issued_at ? String(row.issued_at) : null,
      categoryName: String(category?.name ?? "Ingresso único"), batchName: String(batch?.name ?? "Sem lote"),
      holderName: row.participant_id || orderItem?.participant_id ? String(participant?.full_name ?? orderItem?.holder_full_name ?? "Titular não identificado") : "Titular não definido",
      shirt: [orderItem?.shirt_type, orderItem?.shirt_size].filter(Boolean).join(" · "),
      orderNumber: order?.order_number ? String(order.order_number) : null,
      shortCode: String(row.token ?? row.id).slice(0, 8).toUpperCase(),
      checkinDone: Boolean(row.used_at) || String(row.status) === "used",
      kitStatus: kitItems.length === 0 ? null : kitItems.every((item) => item.status === "delivered") ? "Entregue" : "Pendente",
    }];
  });
  const groups = groupContactTickets(tickets);
  const imported = (linkedParticipants ?? []).some((row) => (Array.isArray(row.participation_history) ? row.participation_history : []).some((entry) => entry.source === "import"));
  const grantableEvents = (eventRows ?? []).map((event) => ({ id: String(event.id), name: String(event.name) }));
  const additionalItems = (additionalOrderRows ?? []).flatMap((order) => {
    const event = relation(order.events);
    const paymentMethod = String(order.payment_method ?? "");
    return (Array.isArray(order.store_order_items) ? order.store_order_items : []).flatMap((item) => {
      if (String(item.status) === "cancelled") return [];
      const product = relation(item.store_items);
      const variant = relation(item.store_item_variants);
      return [{
        id: String(item.id), eventName: String(event?.name ?? "Evento"), productName: String(product?.name ?? "Item"),
        variantLabel: variant ? [variant.name, variant.value].filter(Boolean).join(" ") : null,
        quantity: Number(item.quantity ?? 1), status: String(item.status ?? "reserved"),
        isCourtesy: paymentMethod === "admin_courtesy",
      }];
    });
  });

  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100"><div className="mx-auto flex max-w-7xl gap-6"><Sidebar/><div className="min-w-0 flex-1 space-y-6">
    <TopBar title={String(contact.full_name)} subtitle="Ficha global da pessoa" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Cadastros",href:"/cadastros"},{label:String(contact.full_name)}]} backHref="/cadastros" fallbackHref="/cadastros"/>
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Dados globais</h2><p className="mt-1 text-sm text-slate-400">Este cadastro não pertence a um evento.</p></div><div className="flex flex-wrap gap-2"><Link href={`/cadastros/${id}/editar`} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Editar cadastro</Link>{canIssueTicket ? <Link href={`/ingressos/emitir?from=cadastro&contactId=${encodeURIComponent(id)}`} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400">Emitir ingresso</Link> : null}{canGrantStoreItems ? <ContactGrantStoreItemButton contactId={id} events={grantableEvents}/> : null}</div></div>
      <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[["Nome",contact.full_name],["CPF",contact.cpf],["Nascimento",contact.birth_date],["Gênero",contact.gender],["Telefone",contact.phone],["E-mail",contact.email],["Cidade",contact.city],["Origem",imported ? "Importação" : "Cadastro global"],["Conta vinculada",accountIds.length ? `${accountIds.length} conta(s)` : "Não vinculada"],["Criado em",contact.created_at ? new Date(String(contact.created_at)).toLocaleString("pt-BR") : null]].map(([label,value]) => <div key={String(label)}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 break-words">{valueOrFallback(value)}</dd></div>)}</dl>
      <div className="mt-4"><CopyableId label="PIN do cadastro" value={contact.public_pin ? String(contact.public_pin) : null}/></div>
    </section>
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
      <h2 className="text-lg font-semibold">Itens adicionais</h2><p className="text-sm text-slate-400">Produtos vinculados diretamente a este cadastro, separados dos ingressos.</p>
      {additionalItems.length === 0 ? <p className="mt-5 rounded-2xl border border-dashed border-slate-700 p-6 text-center text-slate-400">Nenhum item adicional vinculado.</p> : <div className="mt-5 grid gap-3 sm:grid-cols-2">{additionalItems.map((item) => <article key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{item.productName}{item.variantLabel ? ` — ${item.variantLabel}` : ""} ×{item.quantity}</p><p className="mt-1 text-xs text-slate-400">{item.eventName}{item.isCourtesy ? " · Cortesia" : ""}</p></div><span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs">{item.status === "delivered" ? "Entregue" : item.status === "confirmed" ? "Pendente" : "Aguardando pagamento"}</span></div></article>)}</div>}
    </section>
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6"><div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Ingressos</h2><p className="text-sm text-slate-400">{tickets.length} ingresso(s) em {groups.length} evento(s)</p></div></div>
      {groups.length === 0 ? <p className="mt-6 rounded-2xl border border-dashed border-slate-700 p-8 text-center text-slate-400">Esta pessoa ainda não possui ingressos.</p> : <div className="mt-5 grid gap-5 xl:grid-cols-2">{groups.map((group) => <article key={group.eventId} className="rounded-3xl border border-slate-700/80 bg-slate-950/50 p-4 shadow-lg shadow-black/10"><div className="mb-3 border-b border-slate-800 pb-3"><p className="text-xs uppercase tracking-[0.18em] text-slate-500">Evento</p><h3 className="mt-1 text-lg font-semibold text-emerald-200">{group.eventName}</h3><p className="text-xs text-slate-400">{group.tickets.length} ingresso(s)</p></div><div className="grid gap-2">{group.tickets.map((ticket) => <Link key={ticket.ticketId} href={`/ingressos/${ticket.ticketId}?from=cadastro&contactId=${id}`} className="group rounded-2xl border border-slate-800 bg-slate-900/70 p-4 transition hover:-translate-y-0.5 hover:border-emerald-500/60 hover:bg-slate-900"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold group-hover:text-emerald-200">{ticket.categoryName}</p><p className="mt-0.5 font-mono text-xs text-slate-500">#{ticket.shortCode}</p></div><span className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs">{ticket.status}</span></div><p className="mt-2 text-xs font-medium uppercase tracking-wide text-emerald-300">{ticket.roleLabel}</p><p className="mt-2 text-sm text-slate-300">Titular: {ticket.holderName}</p><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">{ticket.kitStatus ? <span>Kit: {ticket.kitStatus}</span> : null}<span>Check-in: {ticket.checkinDone ? "Realizado" : "Pendente"}</span>{ticket.shirt ? <span>{ticket.shirt}</span> : null}</div></Link>)}</div></article>)}</div>}
    </section>
  </div></div></main>;
}
