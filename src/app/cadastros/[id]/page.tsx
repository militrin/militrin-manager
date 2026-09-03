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
import { AddToTeamButton } from "../add-to-team-button";
import { InviteAccountButton } from "../invite-account-button";
import { ticketDisplayReference } from "@/lib/display-reference";
import { OwnerCancelAdditionalItemButton, OwnerCancelTicketButton } from "../administrative-delete-actions";
import { ImportedPaymentConfirmation } from "../imported-payment-confirmation";

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
  const organizationContext = await getCurrentOrganizationContext();
  const organization = organizationContext.organization;
  const isOrganizationOwner = organizationContext.isOrgOwner;
  if (!organization?.id) notFound();

  const [{ data: contact, error: contactError }, { data: ticketRows, error: ticketsError }, { data: linkedParticipants, error: participantsError }, { data: eventRows, error: eventsError }, { data: additionalOrderRows, error: additionalItemsError }, canIssueTicket, grantPermissions, canEditTeam, canInviteFirstAccess, canCancelTicketByPermission, canConfirmPayment] = await Promise.all([
    supabase.from("registration_contacts").select("id,full_name,cpf,birth_date,gender,phone,email,city,created_at,public_pin,user_id").eq("id", id).eq("organization_id", organization.id).maybeSingle(),
    supabase.from("tickets").select("id,token,status,issued_at,used_at,event_id,owner_user_id,participant_id,order_id,order_item_id,events(id,name,starts_at),orders(order_number,display_number,status),order_items(item_position,participant_id,registration_contact_id,holder_full_name,shirt_type,shirt_size,ticket_categories(name),registration_batches(name)),participants(registration_contact_id,full_name),participant_kit_items(status)").eq("organization_id", organization.id).range(0, 4999),
    supabase.from("participants").select("id,user_id,registration_contact_id,participation_history(source)").eq("registration_contact_id", id).eq("organization_id", organization.id).range(0, 4999),
    supabase.from("events").select("id,name,starts_at").eq("organization_id", organization.id).order("starts_at", { ascending: false }),
    supabase.from("store_orders").select("id,event_id,payment_method,payment_status,created_at,events(name),store_order_items(id,quantity,status,delivered_at,store_items(name),store_item_variants(name,value))").eq("organization_id", organization.id).eq("registration_contact_id", id).neq("status", "cancelled").order("created_at", { ascending: false }),
    hasPermission("participants.create"),
    Promise.all([hasPermission("store.grant_items"), hasPermission("store.manage")]),
    hasPermission("team.edit_permissions"),
    hasPermission("participants.edit_basic"),
    hasPermission("orders.cancel"),
    hasPermission("finance.confirm_payment"),
  ]);
  if (contactError) throw contactError;
  if (!contact) notFound();
  if (ticketsError) throw ticketsError;
  if (participantsError) throw participantsError;
  if (eventsError) throw eventsError;
  if (additionalItemsError) throw additionalItemsError;
  const canGrantStoreItems = grantPermissions.some(Boolean);
  // Cancelar ingresso segue o mesmo idioma de autorizacao da RPC
  // (owner_cancel_ticket): Owner OU orders.cancel -- nao mais Owner-only.
  // Ver auditoria em 20260924000000_ticket_cancellation_replacement_intent.sql.
  const canCancelTickets = isOrganizationOwner || canCancelTicketByPermission;
  const accountIds = Array.from(new Set([
    ...(contact.user_id ? [String(contact.user_id)] : []),
    ...(linkedParticipants ?? []).flatMap((row) => row.user_id ? [String(row.user_id)] : []),
  ]));
  const linkedAccountIds = new Set(accountIds);

  // "Adicionar à equipe" / "Editar acesso da equipe": so quando a Pessoa
  // (registration_contacts.user_id -- vinculo canonico de conta, nao
  // participants.user_id, que e por evento) ja tem uma conta. Duas queries
  // extras so quando fazem sentido, pra nao pagar o custo em toda ficha.
  const contactUserId = contact.user_id ? String(contact.user_id) : null;
  let isExistingTeamMember = false;
  let teamRoleOptions: { id: string; name: string }[] = [];
  if (contactUserId && canEditTeam) {
    // admin_users tem RLS ligado sem nenhuma policy de SELECT -- uma leitura
    // direta (.from("admin_users")...) sempre volta vazia pro client do
    // usuario, entao isExistingTeamMember ficava sempre false mesmo pra quem
    // já era da equipe. is_admin_team_member (migration 20260886000000,
    // local, NAO aplicada ainda) é um boolean minimo via RPC SECURITY
    // DEFINER -- não expõe função/status/nome de ninguém, só "é membro?" --
    // e exige a mesma permissão (team.view) que já protege esta seção.
    const [{ data: isTeamMember, error: teamMemberError }, { data: rolesData }] = await Promise.all([
      supabase.rpc("is_admin_team_member", { p_user_id: contactUserId }),
      supabase.rpc("list_admin_roles"),
    ]);
    isExistingTeamMember = !teamMemberError && Boolean(isTeamMember);
    teamRoleOptions = (rolesData ?? []).map((role: { id: string; name: string }) => ({ id: String(role.id), name: String(role.name) }));
  }
  let inviteEligibility = {
    canInvite: false,
    inviteStatus: "forbidden" as "available" | "pending" | "linked" | "blocked" | "forbidden",
    reason: "Sem permissao para enviar convites.",
  };
  if (!contact.user_id && canInviteFirstAccess) {
    const result = await supabase.rpc("check_registration_contact_account_invite_eligibility", {
      p_registration_contact_id: id,
    });
    const row = (Array.isArray(result.data) ? result.data[0] : result.data) as {
      eligible?: boolean; reason_code?: string; reason_message?: string;
    } | null;
    const reasonCode = result.error ? "evaluation_error" : String(row?.reason_code ?? "evaluation_error");
    inviteEligibility = {
      canInvite: !result.error && Boolean(row?.eligible),
      inviteStatus: reasonCode.startsWith("resend_invite_") ? "pending"
        : reasonCode === "already_linked" ? "linked"
          : row?.eligible ? "available" : "blocked",
      reason: result.error?.message ?? String(row?.reason_message ?? "Nao foi possivel avaliar o convite."),
    };
  }

  const tickets = (ticketRows ?? []).flatMap((row) => {
    const orderItem = relation(row.order_items);
    const participant = relation(row.participants);
    const event = relation(row.events);
    const link = {
      ticketId: String(row.id), orderItemId: String(row.order_item_id), eventId: String(row.event_id), eventName: String(event?.name ?? "Evento"),
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
      ticketId: String(row.id), orderItemId: String(row.order_item_id), eventId: String(row.event_id), eventName: String(event?.name ?? "Evento"),
      participantContactId: participant?.registration_contact_id ? String(participant.registration_contact_id) : null,
      orderItemContactId: orderItem?.registration_contact_id ? String(orderItem.registration_contact_id) : null,
      ownerUserId: link.ownerUserId, roles, roleLabel: contactTicketRoleLabel(roles),
      status: String(row.status ?? "pending"), issuedAt: row.issued_at ? String(row.issued_at) : null,
      categoryName: String(category?.name ?? "Ingresso único"), batchName: String(batch?.name ?? "Sem lote"),
      holderName: row.participant_id || orderItem?.participant_id ? String(participant?.full_name ?? orderItem?.holder_full_name ?? "Titular não identificado") : "Titular não definido",
      shirt: [orderItem?.shirt_type, orderItem?.shirt_size].filter(Boolean).join(" · "),
      orderNumber: order?.order_number ? String(order.order_number) : null,
      shortCode: ticketDisplayReference(order?.display_number, orderItem?.item_position ?? 1, order?.order_number).replace(/^#/, ""),
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
        id: String(item.id), orderId: String(order.id), eventName: String(event?.name ?? "Evento"), productName: String(product?.name ?? "Item"),
        variantLabel: variant ? [variant.name, variant.value].filter(Boolean).join(" ") : null,
        quantity: Number(item.quantity ?? 1), status: String(item.status ?? "reserved"),
        isCourtesy: paymentMethod === "admin_courtesy", paymentStatus: String(order.payment_status ?? "pending"),
      }];
    });
  });

  const { data: importedRightRows, error: importedRightsError } = await supabase.from("order_items")
    .select("id,participant_id,event_id,order_id,status,events(name),orders!inner(id,buyer_type,import_batch_id,payment_id)")
    .eq("registration_contact_id", id).eq("item_kind", "ticket")
    .not("status", "in", "(cancelled,expired,refunded,transferred)");
  if (importedRightsError) throw importedRightsError;
  const importedRights = (importedRightRows ?? []).filter((row) => {
    const order = relation(row.orders);
    return order?.buyer_type === "imported_holder" && Boolean(order.import_batch_id)
      && !tickets.some((ticket) => ticket.orderItemId === String(row.id));
  });
  const pendingPaymentIds = Array.from(new Set(importedRights.flatMap((row) => {
    const paymentId = relation(row.orders)?.payment_id;
    return paymentId ? [String(paymentId)] : [];
  })));
  const { data: importedPayments, error: importedPaymentsError } = pendingPaymentIds.length
    ? await supabase.from("payments").select("id,payment_status").in("id", pendingPaymentIds)
    : { data: [], error: null };
  if (importedPaymentsError) throw importedPaymentsError;
  const paymentStatusById = new Map((importedPayments ?? []).map((payment) => [String(payment.id), String(payment.payment_status)]));
  const pendingImportedRights = importedRights.filter((row) => paymentStatusById.get(String(relation(row.orders)?.payment_id ?? "")) === "pending");

  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100"><div className="mx-auto flex max-w-7xl gap-6"><Sidebar/><div className="min-w-0 flex-1 space-y-6">
    <TopBar title={String(contact.full_name)} subtitle="Ficha global da pessoa" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Cadastros",href:"/cadastros"},{label:String(contact.full_name)}]} backHref="/cadastros" fallbackHref="/cadastros"/>
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Dados globais</h2><p className="mt-1 text-sm text-slate-400">Este cadastro não pertence a um evento.</p></div><div className="flex flex-wrap gap-2"><Link href={`/cadastros/${id}/editar`} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Editar cadastro</Link>{canIssueTicket ? <Link href={`/ingressos/emitir?from=cadastro&contactId=${encodeURIComponent(id)}`} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400">Emitir ingresso</Link> : null}{canGrantStoreItems ? <ContactGrantStoreItemButton contactId={id} events={grantableEvents}/> : null}{contactUserId && canEditTeam ? (isExistingTeamMember ? <Link href={`/painel/configuracoes/equipe/${contactUserId}`} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Editar acesso da equipe</Link> : <AddToTeamButton userId={contactUserId} contactId={id} contactName={String(contact.full_name)} roleOptions={teamRoleOptions}/>) : null}</div></div>
      <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[["Nome",contact.full_name],["CPF",contact.cpf],["Nascimento",contact.birth_date],["Gênero",contact.gender],["Telefone",contact.phone],["E-mail",contact.email],["Cidade",contact.city],["Origem",imported ? "Importação" : "Cadastro global"],["Conta vinculada",accountIds.length ? `${accountIds.length} conta(s)` : "Não vinculada"],["Criado em",contact.created_at ? new Date(String(contact.created_at)).toLocaleString("pt-BR") : null]].map(([label,value]) => <div key={String(label)}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 break-words">{valueOrFallback(value)}</dd></div>)}</dl>
      <div className="mt-4"><CopyableId label="PIN do cadastro" value={contact.public_pin ? String(contact.public_pin) : null}/></div>
      {!contactUserId ? (
        <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
          <p className="text-sm text-slate-300">Esta pessoa ainda não possui uma conta vinculada.</p>
          <div className="mt-3"><InviteAccountButton contactId={id} {...inviteEligibility}/></div>
        </div>
      ) : null}
    </section>
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
      <h2 className="text-lg font-semibold">Itens adicionais</h2><p className="text-sm text-slate-400">Produtos vinculados diretamente a este cadastro, separados dos ingressos.</p>
      {additionalItems.length === 0 ? <p className="mt-5 rounded-2xl border border-dashed border-slate-700 p-6 text-center text-slate-400">Nenhum item adicional vinculado.</p> : <div className="mt-5 grid gap-3 sm:grid-cols-2">{additionalItems.map((item) => <div key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{item.productName}{item.variantLabel ? ` — ${item.variantLabel}` : ""} ×{item.quantity}</p><p className="mt-1 text-xs text-slate-400">{item.eventName}{item.isCourtesy ? " · Concedido pela organização" : ""}</p></div><span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs">{item.status === "delivered" ? "Entregue" : item.status === "confirmed" ? "Pendente" : "Aguardando pagamento"}</span></div><div className="mt-3 flex items-center gap-4"><Link href={`/loja/pedidos/${item.orderId}#item-${item.id}`} className="text-xs font-semibold text-emerald-300">Ver item</Link>{isOrganizationOwner ? <OwnerCancelAdditionalItemButton contactId={id} itemId={item.id} details={[`Produto: ${item.productName}`,`Variante: ${item.variantLabel ?? "Sem variante"}`,`Quantidade: ${item.quantity}`,`Origem: ${item.isCourtesy ? "Concessão administrativa" : "Pedido da loja"}`,`Status: ${item.status}`,`Pagamento: ${item.paymentStatus}`]}/> : null}</div></div>)}</div>}
    </section>
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6"><div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Ingressos</h2><p className="text-sm text-slate-400">{tickets.length} ingresso(s) em {groups.length} evento(s)</p></div></div>
      {pendingImportedRights.length ? <div className="mt-5 grid gap-3">{pendingImportedRights.map((right) => { const order=relation(right.orders); const event=relation(right.events); const paymentId=String(order?.payment_id ?? ""); return <div key={String(right.id)} className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"><p className="font-semibold text-amber-100">Ingresso importado aguardando pagamento</p><p className="mt-1 text-sm text-amber-100/80">{String(event?.name ?? "Evento")} · o ingresso não foi emitido porque o pagamento importado está pendente.</p><div className="mt-3 flex flex-wrap gap-3"><Link href={`/inscricoes/pedido/${String(order?.id ?? right.order_id)}`} className="rounded-xl border border-amber-400/40 px-3 py-2 text-sm text-amber-100">Abrir pedido</Link></div>{canConfirmPayment && paymentId ? <ImportedPaymentConfirmation paymentId={paymentId}/> : <p className="mt-3 text-xs text-slate-300">Peça a um administrador com permissão financeira para confirmar o pagamento.</p>}</div>; })}</div> : null}
      {groups.length === 0 && pendingImportedRights.length === 0 ? <p className="mt-6 rounded-2xl border border-dashed border-slate-700 p-8 text-center text-slate-400">Esta pessoa ainda não possui ingressos nem direitos importados pendentes.</p> : <div className="mt-5 grid gap-5 xl:grid-cols-2">{groups.map((group) => <article key={group.eventId} className="rounded-3xl border border-slate-700/80 bg-slate-950/50 p-4 shadow-lg shadow-black/10"><div className="mb-3 border-b border-slate-800 pb-3"><p className="text-xs uppercase tracking-[0.18em] text-slate-500">Evento</p><h3 className="mt-1 text-lg font-semibold text-emerald-200">{group.eventName}</h3><p className="text-xs text-slate-400">{group.tickets.length} ingresso(s)</p></div><div className="grid gap-2">{group.tickets.map((ticket) => <div key={ticket.ticketId} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold">{ticket.categoryName}</p><p className="mt-0.5 font-mono text-xs text-slate-500">#{ticket.shortCode}</p></div><span className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs">{ticket.status}</span></div><p className="mt-2 text-xs font-medium uppercase tracking-wide text-emerald-300">{ticket.roleLabel}</p><p className="mt-2 text-sm text-slate-300">Titular: {ticket.holderName}</p><div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">{ticket.kitStatus ? <span>Kit: {ticket.kitStatus}</span> : null}<span>Check-in: {ticket.checkinDone ? "Realizado" : "Pendente"}</span>{ticket.shirt ? <span>{ticket.shirt}</span> : null}</div><div className="mt-3 flex items-center gap-4"><Link href={`/ingressos/${ticket.ticketId}?from=cadastro&contactId=${id}`} className="text-xs font-semibold text-emerald-300">Ver ingresso</Link>{canCancelTickets ? <OwnerCancelTicketButton contactId={id} ticketId={ticket.ticketId} alreadyCancelled={ticket.status === "cancelled"} details={[`${ticket.categoryName}`,`#${ticket.shortCode}`,`Status: ${ticket.status}`,`Check-in: ${ticket.checkinDone ? "Realizado" : "Pendente"}`,`Kit: ${ticket.kitStatus ?? "Sem itens"}`]}/> : null}</div></div>)}</div></article>)}</div>}
    </section>
  </div></div></main>;
}
