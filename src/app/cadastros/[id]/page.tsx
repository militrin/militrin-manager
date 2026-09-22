import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { CopyableId } from "@/components/CopyableId";
import { hasPermission, requireAnyPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { resolveOperatorNames } from "@/lib/admin/operator-names";
import { isUuidLike } from "@/lib/admin/operator-display";
import { TicketIdentitySummary } from "@/components/tickets/TicketIdentitySummary";
import { buildTicketIdentityView, contactIdForTicket, contactTicketRoleLabel, groupContactTickets, isPendingFirstAccessInvite, rolesForContactTicket } from "@/lib/registrations/contact-tickets";
import { cadastroHrefForOwnedTicket, classifyCadastroListing, fichaIncludesOwnedTicket, holderOnlyTicketPointers } from "@/lib/registrations/cadastro-listing";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ContactGrantStoreItemButton } from "../contact-store-items";
import { AddToTeamButton } from "../add-to-team-button";
import { ContactAccountCard } from "../contact-account-card";
import { ticketDisplayReference, publicOrderCode } from "@/lib/display-reference";
import { OwnerCancelAdditionalItemButton, OwnerCancelTicketButton } from "../administrative-delete-actions";
import { ImportedPaymentConfirmation } from "../imported-payment-confirmation";
import { additionalTicketHolderUnassignedCopy, formatImportedPurchaseWithoutTicketCopy, formatIssuanceBlockerMessages } from "@/lib/imports/issuance-presentation";
import { canonicalHolderName, hasCanonicalHolderName } from "@/lib/tickets/holder-name";
import { loadSharedEmailGroup } from "@/lib/account/load-shared-email-group";
import { SharedEmailAccountCard } from "../shared-email-account-card";

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
    supabase.from("tickets").select("id,token,status,issued_at,used_at,event_id,owner_user_id,intended_owner_contact_id,participant_id,order_id,order_item_id,events(id,name,starts_at),orders(order_number,display_number,status),order_items(item_position,participant_id,registration_contact_id,ownership_status,holder_full_name,shirt_type,shirt_size,ticket_categories(name),registration_batches(name)),participants(registration_contact_id,full_name),participant_kit_items(status)").eq("organization_id", organization.id).range(0, 4999),
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
  let accountBlock = {
    state: (contact.user_id ? "active" : "none") as "active" | "pending_confirmation" | "existing_confirmed" | "none" | "attention" | "linked_to_other_account",
    reasonCode: contact.user_id ? "already_linked" : "evaluation_error",
    reason: contact.user_id ? "Conta vinculada." : "Sem permissao para enviar convites.",
    canInvite: false,
    canResendConfirmation: false,
    email: contact.email ? String(contact.email) : null,
  };
  if (canInviteFirstAccess) {
    const result = await supabase.rpc("get_registration_contact_account_state", {
      p_registration_contact_id: id,
    });
    const row = (Array.isArray(result.data) ? result.data[0] : result.data) as {
      state?: string;
      reason_code?: string;
      reason_message?: string;
      email?: string | null;
      can_resend_confirmation?: boolean;
      can_invite?: boolean;
    } | null;
    if (!result.error && row?.state) {
      accountBlock = {
        state: row.state as typeof accountBlock.state,
        reasonCode: String(row.reason_code ?? "evaluation_error"),
        reason: String(row.reason_message ?? "Nao foi possivel avaliar a conta."),
        canInvite: Boolean(row.can_invite),
        canResendConfirmation: Boolean(row.can_resend_confirmation),
        email: row.email ? String(row.email) : accountBlock.email,
      };
    } else if (result.error) {
      accountBlock = {
        ...accountBlock,
        state: "attention",
        reasonCode: "evaluation_error",
        reason: result.error.message,
      };
    }
  }
  const { data: latestInvite } = !contact.user_id
    ? await supabase.from("participant_account_invites")
      .select("status,expires_at,auth_link_expires_at")
      .eq("registration_contact_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    : { data: null };
  const inviteRecord = latestInvite
    ? { status: String(latestInvite.status), expiresAt: latestInvite.expires_at ? String(latestInvite.expires_at) : null, authLinkExpiresAt: latestInvite.auth_link_expires_at ? String(latestInvite.auth_link_expires_at) : null }
    : null;

  const listingTickets = (ticketRows ?? []).map((row) => {
    const orderItem = relation(row.order_items);
    const participant = relation(row.participants);
    return {
      ticketId: String(row.id),
      eventId: String(row.event_id),
      status: row.status ? String(row.status) : null,
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
      intendedOwnerContactId: row.intended_owner_contact_id ? String(row.intended_owner_contact_id) : null,
      holderContactId: orderItem?.registration_contact_id
        ? String(orderItem.registration_contact_id)
        : participant?.registration_contact_id
          ? String(participant.registration_contact_id)
          : null,
    };
  });
  const listingClass = classifyCadastroListing({
    contactId: id,
    userId: contact.user_id ? String(contact.user_id) : null,
    hasPendingFirstAccessInvite: isPendingFirstAccessInvite(inviteRecord?.status),
  }, listingTickets);

  if (listingClass === "E") {
    const ownerUserIds = Array.from(new Set(listingTickets.flatMap((ticket) => (ticket.ownerUserId ? [ticket.ownerUserId] : []))));
    const intendedIds = Array.from(new Set(listingTickets.flatMap((ticket) => (
      ticket.holderContactId === id && ticket.intendedOwnerContactId ? [ticket.intendedOwnerContactId] : []
    ))));
    const [{ data: ownerContacts, error: ownerContactsError }, { data: intendedContacts, error: intendedContactsError }, ownerNames] = await Promise.all([
      ownerUserIds.length
        ? supabase.from("registration_contacts").select("id,full_name,user_id").eq("organization_id", organization.id).in("user_id", ownerUserIds)
        : Promise.resolve({ data: [] as Array<{ id: string; full_name?: string | null; user_id?: string | null }>, error: null }),
      intendedIds.length
        ? supabase.from("registration_contacts").select("id,full_name").eq("organization_id", organization.id).in("id", intendedIds)
        : Promise.resolve({ data: [] as Array<{ id: string; full_name?: string | null }>, error: null }),
      ownerUserIds.length ? resolveOperatorNames(ownerUserIds) : Promise.resolve(new Map<string, string>()),
    ]);
    if (ownerContactsError) throw ownerContactsError;
    if (intendedContactsError) throw intendedContactsError;
    const ownerContactByUserId = new Map((ownerContacts ?? []).flatMap((row) => (
      row.user_id ? [[String(row.user_id), String(row.id)] as const] : []
    )));
    const ownerNameByContactId = new Map((ownerContacts ?? []).map((row) => [String(row.id), String(row.full_name ?? "")]));
    for (const row of intendedContacts ?? []) ownerNameByContactId.set(String(row.id), String(row.full_name ?? ""));
    const pointers = holderOnlyTicketPointers(id, listingTickets, ownerContactByUserId);
    const uniqueOwners = Array.from(new Map(pointers.map((pointer) => [pointer.ownerContactId ?? pointer.ownerUserId ?? pointer.ticketId, pointer])).values());
    return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100"><div className="mx-auto flex max-w-7xl gap-6"><Sidebar/><div className="min-w-0 flex-1 space-y-6">
      <TopBar title={String(contact.full_name)} subtitle="Somente titular de ingresso" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Cadastros",href:"/cadastros"},{label:String(contact.full_name)}]} backHref="/cadastros" fallbackHref="/cadastros"/>
      <section className="rounded-3xl border border-amber-500/30 bg-amber-500/10 p-6">
        <h2 className="text-lg font-semibold text-amber-100">Esta pessoa não é um Cadastro</h2>
        <p className="mt-2 text-sm text-amber-50/90">{String(contact.full_name)} aparece somente como titular de ingresso pertencente a outra conta. Não possui conta autenticável e não deve ser listada em Cadastros.</p>
        <ul className="mt-4 space-y-2 text-sm">
          {pointers.map((pointer) => {
            const ownerName = pointer.ownerContactId
              ? (ownerNameByContactId.get(pointer.ownerContactId) || (pointer.ownerUserId ? ownerNames.get(pointer.ownerUserId) : null) || "Conta proprietária")
              : (pointer.ownerUserId ? ownerNames.get(pointer.ownerUserId) ?? "Conta vinculada" : "Conta proprietária");
            const cadastroHref = cadastroHrefForOwnedTicket({
              ownerContactId: pointer.ownerContactId,
              intendedOwnerContactId: pointer.ownerContactId,
              ticketId: pointer.ticketId,
            });
            return <li key={pointer.ticketId} className="rounded-2xl border border-amber-400/20 bg-slate-950/40 p-4">
              <p>Titular: {String(contact.full_name)}</p>
              <p className="mt-1 text-slate-300">Conta / Cadastro: {ownerName}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <Link href={`/ingressos/${pointer.ticketId}`} className="rounded-xl border border-amber-400/40 px-3 py-2 text-amber-100">Abrir ingresso</Link>
                {uniqueOwners.length === 1 && pointer.ownerContactId ? <Link href={cadastroHref} className="rounded-xl border border-slate-600 px-3 py-2 text-slate-200">Abrir cadastro da conta</Link> : null}
              </div>
            </li>;
          })}
        </ul>
        {uniqueOwners.length > 1 ? <p className="mt-4 text-xs text-slate-400">Há mais de um ingresso/conta associados. Abra o ingresso correspondente em vez de um redirecionamento único.</p> : null}
      </section>
    </div></div></main>;
  }

  const relatedTicketRows = (ticketRows ?? []).flatMap((row) => {
    const orderItem = relation(row.order_items);
    const participant = relation(row.participants);
    const event = relation(row.events);
    const link = {
      ticketId: String(row.id),
      eventId: String(row.event_id),
      eventName: String(event?.name ?? "Evento"),
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
      intendedOwnerContactId: row.intended_owner_contact_id ? String(row.intended_owner_contact_id) : null,
      orderItemContactId: orderItem?.registration_contact_id ? String(orderItem.registration_contact_id) : null,
      participantContactId: participant?.registration_contact_id ? String(participant.registration_contact_id) : null,
    };
    const roles = rolesForContactTicket(link, id, linkedAccountIds);
    if (!fichaIncludesOwnedTicket({ listingClass, hasUserId: Boolean(contactUserId), roles })) return [];
    return [{ row, orderItem, participant, event, link, roles }];
  });
  const extraContactIds = Array.from(new Set(relatedTicketRows.flatMap(({ link }) => (
    [contactIdForTicket(link), link.intendedOwnerContactId].filter((value): value is string => Boolean(value) && value !== id)
  ))));
  const ownerUserIds = Array.from(new Set(relatedTicketRows.flatMap(({ link }) => (link.ownerUserId ? [link.ownerUserId] : []))));
  const [{ data: extraContacts, error: extraContactsError }, ownerNames] = await Promise.all([
    extraContactIds.length
      ? supabase.from("registration_contacts").select("id,full_name,user_id").eq("organization_id", organization.id).in("id", extraContactIds)
      : Promise.resolve({ data: [] as Array<{ id: string; full_name?: string | null; user_id?: string | null }>, error: null }),
    ownerUserIds.length ? resolveOperatorNames(ownerUserIds) : Promise.resolve(new Map<string, string>()),
  ]);
  if (extraContactsError) throw extraContactsError;
  const extraContactsById = new Map((extraContacts ?? []).map((row) => [String(row.id), row]));
  const unlinkedHolderIds = Array.from(new Set(relatedTicketRows.flatMap(({ link }) => {
    const holderId = contactIdForTicket(link);
    if (!holderId || holderId === id) return [];
    return extraContactsById.get(holderId)?.user_id ? [] : [holderId];
  })));
  const { data: extraInvites, error: extraInvitesError } = unlinkedHolderIds.length
    ? await supabase.from("participant_account_invites").select("registration_contact_id,status,created_at").in("registration_contact_id", unlinkedHolderIds).order("created_at", { ascending: false })
    : { data: [] as Array<{ registration_contact_id?: string | null; status?: string | null }>, error: null };
  if (extraInvitesError) throw extraInvitesError;
  const extraInviteStatusByContact = new Map<string, string>();
  for (const invite of extraInvites ?? []) {
    const contactId = invite.registration_contact_id ? String(invite.registration_contact_id) : "";
    if (!contactId || extraInviteStatusByContact.has(contactId)) continue;
    extraInviteStatusByContact.set(contactId, String(invite.status ?? ""));
  }
  const sharedEmailGroup = await loadSharedEmailGroup(supabase, organization.id, id);
  const groupHasLinkedAccount = Boolean(sharedEmailGroup?.people.some((person) => person.hasValidAuth));
  const tickets = relatedTicketRows.map(({ row, orderItem, participant, event, link, roles }) => {
    const order = relation(row.orders);
    const category = relation(orderItem?.ticket_categories);
    const batch = relation(orderItem?.registration_batches);
    const kitItems = (Array.isArray(row.participant_kit_items) ? row.participant_kit_items : []) as Array<{ status?: string | null }>;
    const holderId = contactIdForTicket(link);
    const holderIsThisContact = holderId === id;
    const extraHolder = holderId && !holderIsThisContact ? extraContactsById.get(holderId) : null;
    const extraIntended = link.intendedOwnerContactId && link.intendedOwnerContactId !== id ? extraContactsById.get(link.intendedOwnerContactId) : null;
    const holderContactUserId = holderIsThisContact
      ? contactUserId
      : extraHolder?.user_id ? String(extraHolder.user_id) : null;
    const resolvedOwnerName = link.ownerUserId ? String(ownerNames.get(link.ownerUserId) ?? "").trim() : "";
    return {
      ticketId: String(row.id), orderItemId: String(row.order_item_id), eventId: String(row.event_id), eventName: String(event?.name ?? "Evento"),
      participantContactId: participant?.registration_contact_id ? String(participant.registration_contact_id) : null,
      orderItemContactId: orderItem?.registration_contact_id ? String(orderItem.registration_contact_id) : null,
      ownerUserId: link.ownerUserId, intendedOwnerContactId: link.intendedOwnerContactId,
      roles, roleLabel: contactTicketRoleLabel(roles),
      status: String(row.status ?? "pending"), issuedAt: row.issued_at ? String(row.issued_at) : null,
      categoryName: String(category?.name ?? "Ingresso único"), batchName: String(batch?.name ?? "Sem lote"),
      holderName: canonicalHolderName(orderItem?.holder_full_name, participant?.full_name, "Titular não definido"),
      holderUnassigned: !hasCanonicalHolderName(orderItem?.holder_full_name),
      identity: buildTicketIdentityView({
        holderName: canonicalHolderName(orderItem?.holder_full_name, participant?.full_name, "Titular não definido"),
        holderContactUserId,
        holderAccountState: holderIsThisContact ? accountBlock.state : (holderContactUserId ? "active" : "none"),
        holderInviteStatus: holderIsThisContact ? inviteRecord?.status : (holderId ? extraInviteStatusByContact.get(holderId) ?? null : null),
        emailOwnedByOtherAccount: Boolean(
          groupHasLinkedAccount
          && holderId
          && sharedEmailGroup?.people.some((person) => person.id === holderId && !person.hasValidAuth),
        ),
        ownerUserId: link.ownerUserId,
        ownerName: resolvedOwnerName && !isUuidLike(resolvedOwnerName) ? resolvedOwnerName : (link.ownerUserId ? "Conta vinculada" : null),
        intendedOwnerContactId: link.intendedOwnerContactId,
        intendedOwnerName: link.intendedOwnerContactId === id
          ? String(contact.full_name)
          : extraIntended?.full_name ? String(extraIntended.full_name) : null,
        ticketStatus: String(row.status ?? ""),
      }),
      shirt: [orderItem?.shirt_type, orderItem?.shirt_size].filter(Boolean).join(" · "),
      orderNumber: order ? publicOrderCode(order.display_number, order.order_number) : null,
      shortCode: ticketDisplayReference(order?.display_number, orderItem?.item_position, order?.order_number).replace(/^#/, ""),
      checkinDone: Boolean(row.used_at) || String(row.status) === "used",
      kitStatus: kitItems.length === 0 ? null : kitItems.every((item) => item.status === "delivered") ? "Entregue" : "Pendente",
    };
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
    .select("id,participant_id,event_id,order_id,status,events(name),orders!inner(id,buyer_type,import_batch_id,payment_id,price_origin)")
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
  const importedRightIds = importedRights.map((row) => String(row.id));
  const { data: importedRightIssues } = importedRightIds.length
    ? await supabase.from("participant_data_issues").select("order_item_id,issue_type,message,blocks_ticket_issuance,status").in("order_item_id", importedRightIds).eq("status", "open")
    : { data: [] as Array<{ order_item_id?: string | null; issue_type?: string | null; message?: string | null; blocks_ticket_issuance?: boolean | null; status?: string | null }> };
  const importedIssuesByItem = new Map<string, NonNullable<typeof importedRightIssues>>();
  for (const issue of importedRightIssues ?? []) {
    const key = String(issue.order_item_id ?? "");
    if (!key) continue;
    importedIssuesByItem.set(key, [...(importedIssuesByItem.get(key) ?? []), issue]);
  }
  const linkedAccountOwner = sharedEmailGroup?.people.find((person) => person.hasValidAuth && person.id !== id) ?? null;
  const cardState = (!contact.user_id && (linkedAccountOwner || accountBlock.state === "linked_to_other_account"))
    ? "linked_to_other_account" as const
    : accountBlock.state;
  const cardCanInvite = cardState === "linked_to_other_account" ? false : accountBlock.canInvite;

  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100"><div className="mx-auto flex max-w-7xl gap-6"><Sidebar/><div className="min-w-0 flex-1 space-y-6">
    <TopBar title={String(contact.full_name)} subtitle="Ficha global da pessoa" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Cadastros",href:"/cadastros"},{label:String(contact.full_name)}]} backHref="/cadastros" fallbackHref="/cadastros"/>
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Dados globais</h2><p className="mt-1 text-sm text-slate-400">Este cadastro não pertence a um evento.</p></div><div className="flex flex-wrap gap-2"><Link href={`/cadastros/${id}/editar`} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Editar cadastro</Link>{canIssueTicket ? <Link href={`/ingressos/emitir?from=cadastro&contactId=${encodeURIComponent(id)}`} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400">Emitir ingresso</Link> : null}{canGrantStoreItems ? <ContactGrantStoreItemButton contactId={id} events={grantableEvents}/> : null}{contactUserId && canEditTeam ? (isExistingTeamMember ? <Link href={`/painel/configuracoes/equipe/${contactUserId}`} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Editar acesso da equipe</Link> : <AddToTeamButton userId={contactUserId} contactId={id} contactName={String(contact.full_name)} roleOptions={teamRoleOptions}/>) : null}</div></div>
      <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[["Nome",contact.full_name],["CPF",contact.cpf],["Nascimento",contact.birth_date],["Gênero",contact.gender],["Telefone",contact.phone],["E-mail",contact.email],["Cidade",contact.city],["Origem",imported ? "Importação" : "Cadastro global"],["Conta vinculada",accountIds.length ? `${accountIds.length} conta(s)` : "Não vinculada"],["Criado em",contact.created_at ? new Date(String(contact.created_at)).toLocaleString("pt-BR") : null]].map(([label,value]) => <div key={String(label)}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 break-words">{valueOrFallback(value)}</dd></div>)}</dl>
      <div className="mt-4"><CopyableId label="PIN do cadastro" value={contact.public_pin ? String(contact.public_pin) : null}/></div>
      <ContactAccountCard
        contactId={id}
        email={accountBlock.email}
        state={cardState}
        reasonCode={cardState === "linked_to_other_account" ? "email_already_has_account" : accountBlock.reasonCode}
        reason={accountBlock.reason}
        canInvite={cardCanInvite}
        canResendConfirmation={cardState === "linked_to_other_account" ? false : accountBlock.canResendConfirmation}
        linkedAccountOwnerName={linkedAccountOwner?.name ?? null}
        inviteRecord={cardState === "linked_to_other_account" ? null : inviteRecord}
      />
    </section>
    {sharedEmailGroup ? <SharedEmailAccountCard group={sharedEmailGroup} contactId={id} /> : null}
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
      <h2 className="text-lg font-semibold">Itens adicionais</h2><p className="text-sm text-slate-400">Produtos vinculados diretamente a este cadastro, separados dos ingressos.</p>
      {additionalItems.length === 0 ? <p className="mt-5 rounded-2xl border border-dashed border-slate-700 p-6 text-center text-slate-400">Nenhum item adicional vinculado.</p> : <div className="mt-5 grid gap-3 sm:grid-cols-2">{additionalItems.map((item) => <div key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{item.productName}{item.variantLabel ? ` — ${item.variantLabel}` : ""} ×{item.quantity}</p><p className="mt-1 text-xs text-slate-400">{item.eventName}{item.isCourtesy ? " · Concedido pela organização" : ""}</p></div><span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs">{item.status === "delivered" ? "Entregue" : item.status === "confirmed" ? "Pendente" : "Aguardando pagamento"}</span></div><div className="mt-3 flex items-center gap-4"><Link href={`/loja/pedidos/${item.orderId}#item-${item.id}`} className="text-xs font-semibold text-emerald-300">Ver item</Link>{isOrganizationOwner ? <OwnerCancelAdditionalItemButton contactId={id} itemId={item.id} financeHref={`/loja/pedidos/${item.orderId}#pagamento`} details={[`Produto: ${item.productName}`,`Variante: ${item.variantLabel ?? "Sem variante"}`,`Quantidade: ${item.quantity}`,`Origem: ${item.isCourtesy ? "Concessão administrativa" : "Pedido da loja"}`,`Status: ${item.status}`,`Pagamento: ${item.paymentStatus}`]}/> : null}</div></div>)}</div>}
    </section>
    <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6"><div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Ingressos</h2><p className="text-sm text-slate-400">{tickets.length} ingresso(s) em {groups.length} evento(s)</p></div></div>
      {importedRights.length ? <div className="mt-5 grid gap-3">{importedRights.map((right) => { const order=relation(right.orders); const event=relation(right.events); const paymentId=String(order?.payment_id ?? ""); const unknownPrice=String(order?.price_origin ?? "")==="legacy_unknown"; const awaitingPayment=!unknownPrice && paymentStatusById.get(paymentId)==="pending"; const blockerMessages=formatIssuanceBlockerMessages(importedIssuesByItem.get(String(right.id)) ?? []); return <div key={String(right.id)} className={awaitingPayment ? "rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4" : "rounded-2xl border border-slate-700 bg-slate-950/50 p-4"}>{awaitingPayment ? <><p className="font-semibold text-amber-100">Ingresso importado aguardando pagamento</p><p className="mt-1 text-sm text-amber-100/80">{String(event?.name ?? "Evento")} · o ingresso não foi emitido porque o pagamento importado está pendente.</p></> : <><p className="font-semibold text-slate-100">Compra importada preservada</p><p className="mt-1 text-sm text-slate-300">{formatImportedPurchaseWithoutTicketCopy({ eventName: String(event?.name ?? "Evento"), blockerMessages })}</p></>}<div className="mt-3 flex flex-wrap gap-3"><Link href={`/inscricoes/pedido/${String(order?.id ?? right.order_id)}`} className="rounded-xl border border-amber-400/40 px-3 py-2 text-sm text-amber-100">Abrir pedido</Link></div>{awaitingPayment && canConfirmPayment && paymentId ? <ImportedPaymentConfirmation paymentId={paymentId}/> : awaitingPayment ? <p className="mt-3 text-xs text-slate-300">Peça a um administrador com permissão financeira para confirmar o pagamento.</p> : null}</div>; })}</div> : null}
      {groups.length === 0 && importedRights.length === 0 ? <p className="mt-6 rounded-2xl border border-dashed border-slate-700 p-8 text-center text-slate-400">Esta pessoa ainda não possui ingressos nem direitos importados pendentes.</p> : <div className="mt-5 grid gap-5 xl:grid-cols-2">{groups.map((group) => <article key={group.eventId} className="rounded-3xl border border-slate-700/80 bg-slate-950/50 p-4 shadow-lg shadow-black/10"><div className="mb-3 border-b border-slate-800 pb-3"><p className="text-xs uppercase tracking-[0.18em] text-slate-500">Evento</p><h3 className="mt-1 text-lg font-semibold text-emerald-200">{group.eventName}</h3><p className="text-xs text-slate-400">{group.tickets.length} ingresso(s)</p></div><div className="grid gap-2">{group.tickets.map((ticket) => <div key={ticket.ticketId} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold">{ticket.categoryName}</p><p className="mt-0.5 font-mono text-xs text-slate-500">#{ticket.shortCode}</p></div><span className="rounded-full border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs">{ticket.status}</span></div><p className="mt-2 text-xs font-medium uppercase tracking-wide text-emerald-300">{ticket.roleLabel}</p><TicketIdentitySummary identity={ticket.identity} />{ticket.holderUnassigned ? <p className="mt-1 text-xs text-slate-400">{additionalTicketHolderUnassignedCopy()}</p> : null}<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">{ticket.kitStatus ? <span>Kit: {ticket.kitStatus}</span> : null}<span>Check-in: {ticket.checkinDone ? "Realizado" : "Pendente"}</span>{ticket.shirt ? <span>{ticket.shirt}</span> : null}</div><div className="mt-3 flex items-center gap-4"><Link href={`/ingressos/${ticket.ticketId}?from=cadastro&contactId=${id}`} className="text-xs font-semibold text-emerald-300">Ver ingresso</Link>{canCancelTickets ? <OwnerCancelTicketButton contactId={id} ticketId={ticket.ticketId} alreadyCancelled={ticket.status === "cancelled"} details={[`${ticket.categoryName}`,`#${ticket.shortCode}`,`Status: ${ticket.status}`,`Check-in: ${ticket.checkinDone ? "Realizado" : "Pendente"}`,`Kit: ${ticket.kitStatus ?? "Sem itens"}`]}/> : null}</div></div>)}</div></article>)}</div>}
    </section>
  </div></div></main>;
}
