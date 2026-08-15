import Link from "next/link";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { AdminEmptyState, AdminPageHeader, AdminSection, AdminStatCard } from "@/components/admin";
import { getAdminAccessContext } from "@/lib/admin/access";
import { hasPermission } from "@/lib/admin/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type EventRow = { id: string; name: string; starts_at: string | null; organization_id: string };
type Participation = { identity: string; name: string; eventKey: string; eventName: string; year: number; checkedIn: boolean; linked: boolean };
type PersonSummary = { identity: string; name: string; events: Map<string, Participation> };
type Query = { basis?: string; yearFrom?: string; yearTo?: string; minEvents?: string; maxEvents?: string; requiredEvent?: string | string[]; allEvents?: string; lastYears?: string };

const input = "rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100";
const currentYear = new Date().getFullYear();

function one(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function integer(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value); return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
function eventYear(value: string | null) { return value ? Number(value.slice(0, 4)) : 0; }

async function loadData() {
  const supabase = await createServerSupabaseClient();
  const { data: eventsData, error: eventsError } = await supabase.from("events").select("id,name,starts_at,organization_id").order("starts_at", { ascending: false });
  if (eventsError) throw eventsError;
  const events = (eventsData ?? []) as EventRow[];
  const eventIds = events.map((event) => event.id);
  if (!eventIds.length) return { events, participants: [], tickets: [], history: [] };
  const [participants, tickets, history] = await Promise.all([
    supabase.from("participants").select("id,user_id,event_id,full_name,registration_status").in("event_id", eventIds).range(0, 4999),
    supabase.from("tickets").select("id,participant_id,event_id,status,used_at").in("event_id", eventIds).range(0, 4999),
    supabase.from("participation_history").select("id,user_id,participant_id,event_id,event_year,legacy_event_name,full_name,status").eq("status", "confirmed").in("event_id", eventIds).range(0, 4999),
  ]);
  const error = participants.error ?? tickets.error ?? history.error;
  if (error) throw error;
  return { events, participants: participants.data ?? [], tickets: tickets.data ?? [], history: history.data ?? [] };
}

export default async function UsersDashboardPage({ searchParams }: { searchParams: Promise<Query> }) {
  const access = await getAdminAccessContext();
  const canViewParticipants = await hasPermission("participants.view");
  if (!access.user || !access.isAdmin || !canViewParticipants) redirect("/acesso-negado");
  const query = await searchParams;
  const data = await loadData();
  const basis = one(query.basis) === "checkin" ? "checkin" : "confirmed";
  const lastYears = integer(one(query.lastYears), 0, 0, 20);
  const defaultFrom = Math.max(2000, currentYear - 9);
  const yearFrom = lastYears ? currentYear - lastYears + 1 : integer(one(query.yearFrom), defaultFrom, 1900, 2200);
  const yearTo = lastYears ? currentYear : integer(one(query.yearTo), currentYear, 1900, 2200);
  const minEvents = integer(one(query.minEvents), 1, 1, 999);
  const maxEventsRaw = one(query.maxEvents);
  const maxEvents = maxEventsRaw ? integer(maxEventsRaw, 999, 1, 999) : 999;
  const requestedEvents = (Array.isArray(query.requiredEvent) ? query.requiredEvent : query.requiredEvent ? [query.requiredEvent] : []).filter((id) => data.events.some((event) => event.id === id));
  const allEvents = one(query.allEvents) === "true";
  const eventById = new Map(data.events.map((event) => [event.id, event]));
  const usedParticipants = new Set(data.tickets.filter((ticket) => ticket.status === "used" || ticket.used_at).map((ticket) => String(ticket.participant_id)));
  const currentParticipantIds = new Set(data.participants.map((participant) => String(participant.id)));
  const participations: Participation[] = [];

  for (const participant of data.participants) {
    if (String(participant.registration_status) !== "confirmed") continue;
    const event = eventById.get(String(participant.event_id));
    if (!event) continue;
    const userId = participant.user_id ? String(participant.user_id) : null;
    participations.push({ identity: userId ? `user:${userId}` : `participant:${participant.id}`, name: String(participant.full_name), eventKey: event.id, eventName: event.name, year: eventYear(event.starts_at), checkedIn: usedParticipants.has(String(participant.id)), linked: Boolean(userId) });
  }
  for (const history of data.history) {
    if (history.participant_id && currentParticipantIds.has(String(history.participant_id))) continue;
    const event = history.event_id ? eventById.get(String(history.event_id)) : null;
    const userId = history.user_id ? String(history.user_id) : null;
    participations.push({ identity: userId ? `user:${userId}` : history.participant_id ? `participant:${history.participant_id}` : `history:${history.id}`, name: String(history.full_name), eventKey: event?.id ?? `legacy:${history.event_year}:${history.legacy_event_name ?? history.id}`, eventName: event?.name ?? String(history.legacy_event_name ?? `Evento ${history.event_year}`), year: Number(history.event_year), checkedIn: false, linked: Boolean(userId || history.participant_id) });
  }

  const inPeriod = participations.filter((item) => item.year >= Math.min(yearFrom, yearTo) && item.year <= Math.max(yearFrom, yearTo) && (basis === "confirmed" || item.checkedIn));
  const people = new Map<string, PersonSummary>();
  for (const item of inPeriod) {
    const person = people.get(item.identity) ?? { identity: item.identity, name: item.name, events: new Map() };
    if (!person.events.has(item.eventKey)) person.events.set(item.eventKey, item);
    people.set(item.identity, person);
  }
  const universeEventIds = new Set(data.events.filter((event) => { const year=eventYear(event.starts_at); return year >= Math.min(yearFrom, yearTo) && year <= Math.max(yearFrom, yearTo); }).map((event) => event.id));
  const filtered = [...people.values()].filter((person) => {
    const count = person.events.size;
    if (count < minEvents || count > maxEvents) return false;
    if (requestedEvents.some((id) => !person.events.has(id))) return false;
    return !allEvents || [...universeEventIds].every((id) => person.events.has(id));
  }).sort((a, b) => b.events.size - a.events.size || a.name.localeCompare(b.name, "pt-BR"));
  const years = [...new Set(inPeriod.map((item) => item.year))].sort((a, b) => b - a);
  const countByYear = years.map((year) => ({ year, count: new Set(inPeriod.filter((item) => item.year === year).map((item) => item.identity)).size }));
  const distribution = [1, 2, 3, 4, 5].map((count) => ({ label: count === 5 ? "5 ou mais eventos" : `${count} evento${count > 1 ? "s" : ""}`, count: [...people.values()].filter((person) => count === 5 ? person.events.size >= 5 : person.events.size === count).length }));
  const unlinkedCount = new Set(inPeriod.filter((item) => !item.linked).map((item) => item.identity)).size;

  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8"><div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row"><Sidebar/><div className="min-w-0 flex-1 space-y-6">
    <AdminPageHeader title="Público e recorrência" subtitle="Compare anos, recorrência e combinações de eventos sem misturar pessoas por nome." actions={<Link href="/painel" className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Voltar ao Dashboard</Link>}/>
    <AdminSection title="Filtros" description="Participação confirmada inclui o histórico legado; presença exige check-in comprovado.">
      <form className="grid gap-4 lg:grid-cols-4">
        <label className="space-y-1 text-sm">Métrica<select className={`${input} block w-full`} name="basis" defaultValue={basis}><option value="confirmed">Participação confirmada</option><option value="checkin">Presença por check-in</option></select></label>
        <label className="space-y-1 text-sm">Ano inicial<input className={`${input} block w-full`} type="number" name="yearFrom" defaultValue={yearFrom}/></label>
        <label className="space-y-1 text-sm">Ano final<input className={`${input} block w-full`} type="number" name="yearTo" defaultValue={yearTo}/></label>
        <label className="space-y-1 text-sm">Atalho<select className={`${input} block w-full`} name="lastYears" defaultValue={lastYears || ""}><option value="">Período informado</option><option value="3">Últimos 3 anos</option><option value="5">Últimos 5 anos</option></select></label>
        <label className="space-y-1 text-sm">Mínimo de eventos<input className={`${input} block w-full`} type="number" min="1" name="minEvents" defaultValue={minEvents}/></label>
        <label className="space-y-1 text-sm">Máximo de eventos<input className={`${input} block w-full`} type="number" min="1" name="maxEvents" defaultValue={maxEventsRaw ?? ""} placeholder="Sem limite"/></label>
        <label className="flex items-center gap-2 self-end rounded-xl border border-slate-700 px-3 py-2 text-sm"><input type="checkbox" name="allEvents" value="true" defaultChecked={allEvents}/> Participou de todos os eventos do período</label>
        <div className="self-end"><button className="w-full rounded-xl bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950">Aplicar filtros</button></div>
        <fieldset className="lg:col-span-4"><legend className="mb-2 text-sm font-semibold">Deve ter participado de todos os eventos marcados</legend><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{data.events.map((event) => <label key={event.id} className="flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-2 text-sm"><input type="checkbox" name="requiredEvent" value={event.id} defaultChecked={requestedEvents.includes(event.id)}/><span>{event.name}</span></label>)}</div></fieldset>
      </form>
    </AdminSection>
    <AdminSection title="Resumo" description={`${basis === "checkin" ? "Presenças comprovadas" : "Participações confirmadas"} entre ${Math.min(yearFrom, yearTo)} e ${Math.max(yearFrom, yearTo)}.`}><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><AdminStatCard label="Pessoas encontradas" value={filtered.length} tone="success"/>{countByYear.map((item) => <AdminStatCard key={item.year} label={`Participaram em ${item.year}`} value={item.count}/>)}</div>{unlinkedCount ? <p className="mt-3 text-xs text-amber-200">{unlinkedCount} registro(s) histórico(s) ainda não possuem vínculo canônico com uma conta; eles não são unidos por nome.</p> : null}</AdminSection>
    <AdminSection title="Frequência de participação" description="Quantidade de pessoas por número de eventos no período."><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{distribution.map((item) => <AdminStatCard key={item.label} label={item.label} value={item.count}/>)}</div></AdminSection>
    <AdminSection title="Pessoas no resultado" description="Cada evento é contado uma única vez por pessoa.">{filtered.length ? <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="min-w-full text-sm"><thead className="bg-slate-950 text-left text-slate-400"><tr><th className="p-3">Pessoa</th><th className="p-3">Eventos</th><th className="p-3">Quantidade</th><th className="p-3">Anos</th></tr></thead><tbody>{filtered.slice(0, 500).map((person) => { const rows=[...person.events.values()]; return <tr key={person.identity} className="border-t border-slate-800 align-top"><td className="p-3 font-medium">{person.name}</td><td className="p-3">{rows.map((item) => item.eventName).join(", ")}</td><td className="p-3">{rows.length}</td><td className="p-3">{[...new Set(rows.map((item) => item.year))].sort().join(", ")}</td></tr>; })}</tbody></table>{filtered.length > 500 ? <p className="p-3 text-xs text-amber-200">Exibindo as primeiras 500 pessoas. Refine os filtros para reduzir o resultado.</p> : null}</div> : <AdminEmptyState title="Nenhuma pessoa encontrada" description="Ajuste o período, a quantidade ou os eventos obrigatórios."/>}</AdminSection>
  </div></div></main>;
}
