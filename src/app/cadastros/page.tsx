import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { hasPermission } from "@/lib/admin/permissions";
import { contactIdForTicket } from "@/lib/registrations/contact-tickets";
import { countSharedEmails, matchesSharedEmailFilter, normalizeSharedEmail, parseSharedEmailFilter, sharedEmailCountersLabel, sharedEmailGroupStatus } from "@/lib/account/shared-email-ownership";
import { CadastroList } from "./cadastro-list";

type Params = { q?: string; origin?: string; import_batch_id?: string; shared_email?: string };

function relation(value: unknown) {
  return (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
}

function contains(value: unknown, query: string) {
  return String(value ?? "").toLocaleLowerCase("pt-BR").includes(query.toLocaleLowerCase("pt-BR"));
}

export default async function CadastrosPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const supabase = await createServerSupabaseClient();
  const organization = (await getCurrentOrganizationContext()).organization;
  const canEdit = await hasPermission("participants.edit_basic");
  const canIssueTicket = await hasPermission("participants.create");

  if (!organization?.id) {
    return <main className="p-8 text-slate-200">Selecione uma organização para visualizar os cadastros.</main>;
  }

  const [{ data: contacts, error: contactsError }, { data: tickets, error: ticketsError }, { data: participantOrigins, error: originsError }] = await Promise.all([
    supabase
      .from("registration_contacts")
      .select("id,full_name,cpf,birth_date,gender,phone,email,city,created_at,public_pin")
      .eq("organization_id", organization.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("tickets")
      .select("id,event_id,status,intended_owner_contact_id,order_items(registration_contact_id),participants(registration_contact_id),events(name)")
      .eq("organization_id", organization.id)
      .range(0, 4999),
    supabase
      .from("participants")
      .select("registration_contact_id,participation_history(source,import_batch_id)")
      .eq("organization_id", organization.id)
      .not("registration_contact_id", "is", null)
      .range(0, 4999),
  ]);
  if (contactsError) throw contactsError;
  if (ticketsError) throw ticketsError;
  if (originsError) throw originsError;

  const stats = new Map<string, { ticketIds: Set<string>; eventIds: Set<string> }>();
  for (const row of tickets ?? []) {
    const orderItem = relation(row.order_items);
    const participant = relation(row.participants);
    const contactId = contactIdForTicket({
      ticketId: String(row.id),
      eventId: String(row.event_id),
      eventName: String(relation(row.events)?.name ?? "Evento"),
      orderItemContactId: orderItem?.registration_contact_id ? String(orderItem.registration_contact_id) : null,
      participantContactId: participant?.registration_contact_id ? String(participant.registration_contact_id) : null,
    });
    if (!contactId) continue;
    const current = stats.get(contactId) ?? { ticketIds: new Set<string>(), eventIds: new Set<string>() };
    current.ticketIds.add(String(row.id));
    current.eventIds.add(String(row.event_id));
    stats.set(contactId, current);
  }

  const importedContactIds = new Set<string>();
  const importBatchIdsByContact = new Map<string, Set<string>>();
  for (const participant of participantOrigins ?? []) {
    const history = Array.isArray(participant.participation_history) ? participant.participation_history : [];
    if (participant.registration_contact_id && history.some((entry) => entry.source === "import")) {
      const contactId = String(participant.registration_contact_id);
      importedContactIds.add(contactId);
      const batchIds = importBatchIdsByContact.get(contactId) ?? new Set<string>();
      for (const entry of history) if (entry.source === "import" && entry.import_batch_id) batchIds.add(String(entry.import_batch_id));
      importBatchIdsByContact.set(contactId, batchIds);
    }
  }

  const query = params.q?.trim() ?? "";
  const sharedEmailFilter = parseSharedEmailFilter(params.shared_email);
  const sharedEmailCounts = countSharedEmails((contacts ?? []).map((contact) => contact.email ? String(contact.email) : null));
  const namesById = new Map((contacts ?? []).map((contact) => [String(contact.id), String(contact.full_name ?? "")]));
  const emailByContactId = new Map((contacts ?? []).map((contact) => [String(contact.id), normalizeSharedEmail(contact.email ? String(contact.email) : null)]));
  const ticketsByEmail = new Map<string, Array<{ intendedOwnerContactId: string | null }>>();
  for (const row of tickets ?? []) {
    if (["cancelled", "canceled", "void", "voided"].includes(String(row.status ?? ""))) continue;
    const orderItem = relation(row.order_items);
    const participant = relation(row.participants);
    const holderId = participant?.registration_contact_id
      ? String(participant.registration_contact_id)
      : orderItem?.registration_contact_id
        ? String(orderItem.registration_contact_id)
        : "";
    const email = emailByContactId.get(holderId) ?? null;
    if (!email || (sharedEmailCounts.get(email) ?? 0) <= 1) continue;
    const list = ticketsByEmail.get(email) ?? [];
    list.push({ intendedOwnerContactId: row.intended_owner_contact_id ? String(row.intended_owner_contact_id) : null });
    ticketsByEmail.set(email, list);
  }
  const groupStatusByEmail = new Map<string, { status: "pending" | "resolved"; principalName: string | null }>();
  for (const [email, count] of sharedEmailCounts) {
    if (count <= 1) continue;
    const resolution = sharedEmailGroupStatus(ticketsByEmail.get(email) ?? []);
    groupStatusByEmail.set(email, {
      status: resolution.status,
      principalName: resolution.principalId ? namesById.get(resolution.principalId) ?? null : null,
    });
  }
  const pendingGroups = [...groupStatusByEmail.values()].filter((group) => group.status === "pending").length;
  const resolvedGroups = [...groupStatusByEmail.values()].filter((group) => group.status === "resolved").length;
  const rows = (contacts ?? []).map((contact) => {
    const contactStats = stats.get(String(contact.id));
    const origin = importedContactIds.has(String(contact.id)) ? "Importação" : "Cadastro global";
    const email = String(contact.email ?? "");
    const emailKey = normalizeSharedEmail(email);
    const group = emailKey ? groupStatusByEmail.get(emailKey) : null;
    return {
      id: String(contact.id),
      name: String(contact.full_name ?? ""),
      cpf: String(contact.cpf ?? ""),
      birthDate: contact.birth_date ? String(contact.birth_date) : "",
      gender: String(contact.gender ?? ""),
      phone: String(contact.phone ?? ""),
      email,
      city: String(contact.city ?? ""),
      publicPin: contact.public_pin ? String(contact.public_pin) : null,
      origin,
      ticketCount: contactStats?.ticketIds.size ?? 0,
      eventCount: contactStats?.eventIds.size ?? 0,
      sharedEmailCount: emailKey ? sharedEmailCounts.get(emailKey) ?? 0 : 0,
      sharedEmailStatus: group?.status ?? null,
      sharedEmailPrincipalName: group?.principalName ?? null,
      importBatchIds: Array.from(importBatchIdsByContact.get(String(contact.id)) ?? []),
    };
  }).filter((row) => {
    if (query && ![row.name, row.cpf, row.email, row.phone].some((value) => contains(value, query))) return false;
    if (params.origin === "import" && row.origin !== "Importação") return false;
    if (params.origin === "manual" && row.origin === "Importação") return false;
    if (params.import_batch_id && !row.importBatchIds.includes(params.import_batch_id)) return false;
    if (!matchesSharedEmailFilter(row.sharedEmailCount, row.sharedEmailStatus, sharedEmailFilter)) return false;
    return true;
  });

  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100"><div className="mx-auto flex max-w-7xl gap-6"><Sidebar/><div className="min-w-0 flex-1 space-y-6">
    <TopBar title="Cadastros" subtitle={`${organization.name} · pessoas da organização`}/>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-400">{rows.length} pessoa(s) encontrada(s)</p><Link href="/cadastros/novo" className="inline-flex h-10 items-center rounded-xl bg-emerald-500 px-4 font-semibold text-emerald-950">Novo cadastro</Link></div>
    {groupStatusByEmail.size ? <p className="text-sm text-violet-100"><Link href="/cadastros?shared_email=pending" className="hover:underline">Pendentes: {pendingGroups}</Link>{" · "}<Link href="/cadastros?shared_email=resolved" className="hover:underline">Resolvidos: {resolvedGroups}</Link><span className="sr-only">{sharedEmailCountersLabel(pendingGroups, resolvedGroups)}</span><span className="text-slate-500"> · a pendência some ao definir a conta principal; as Pessoas permanecem</span></p> : null}
    {params.import_batch_id ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"><p className="text-sm text-amber-100">Exibindo pessoas vinculadas ao lote de importação, sem alterar a identidade global do cadastro.</p><Link href="/cadastros" className="rounded-xl border border-amber-400/40 px-4 py-2 text-sm text-amber-100">Ver todos os cadastros</Link></div> : null}
    <form className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]">
      <input name="q" defaultValue={query} placeholder="Nome, CPF, e-mail ou telefone" className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"/>
      <select name="origin" defaultValue={params.origin ?? ""} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Todas as origens</option><option value="import">Importação</option><option value="manual">Cadastro global</option></select>
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">E-mail compartilhado</span>
        <select name="shared_email" defaultValue={sharedEmailFilter} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
          <option value="all">Todos</option>
          <option value="pending">Pendentes</option>
          <option value="resolved">Resolvidos</option>
        </select>
      </label>
      {params.import_batch_id ? <input type="hidden" name="import_batch_id" value={params.import_batch_id}/> : null}
      <button className="inline-flex h-10 items-center justify-center self-end rounded-xl border border-emerald-500/40 px-4 text-emerald-200">Filtrar</button>
    </form>
    <CadastroList rows={rows} canEdit={canEdit} canIssueTicket={canIssueTicket}/>
  </div></div></main>;
}
