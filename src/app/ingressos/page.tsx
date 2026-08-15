import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { requireAnyPermission } from "@/lib/admin/permissions";

type Params = { userId?: string };

export default async function TicketsAdminPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireAnyPermission(["participants.view", "orders.view"]);
  const params = await searchParams;
  const supabase = await createServerSupabaseClient();
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) return <main className="p-8 text-slate-200">Selecione uma organização.</main>;

  let holderParticipantIds: string[] | null = null;
  if (params.userId) {
    const { data: holders, error: holderError } = await supabase.from("participants")
      .select("id").eq("user_id", params.userId).eq("organization_id", organization.id);
    if (holderError) throw holderError;
    holderParticipantIds = (holders ?? []).map((holder) => String(holder.id));
  }

  let query = supabase.from("tickets").select(`
    id,status,issued_at,participant_id,organization_id,
    participants(id,full_name,user_id),
    order_items(holder_full_name,ticket_categories(name))
  `).eq("organization_id", organization.id).order("issued_at", { ascending: false }).limit(200);
  if (holderParticipantIds) {
    if (!holderParticipantIds.length) query = query.in("participant_id", ["00000000-0000-0000-0000-000000000000"]);
    else query = query.in("participant_id", holderParticipantIds);
  }
  const { data, error } = await query;
  if (error) throw error;

  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100"><div className="mx-auto flex max-w-7xl gap-6"><Sidebar/><div className="flex-1 space-y-6">
    <TopBar title={params.userId ? "Ingressos da conta" : "Todos os ingressos"} subtitle="Ingressos administrativos"/>
    <div className="flex flex-wrap gap-2"><Link href="/ingressos/emitir" className="inline-flex rounded-xl bg-emerald-500 px-4 py-3 font-semibold text-emerald-950">Emitir ingresso</Link>{params.userId ? <Link href="/ingressos" className="inline-flex rounded-xl border border-slate-700 px-4 py-3">Ver listagem geral</Link> : null}</div>
    <div className="space-y-2">{(data ?? []).map((ticket) => {
      const item = Array.isArray(ticket.order_items) ? ticket.order_items[0] : ticket.order_items;
      const participant = Array.isArray(ticket.participants) ? ticket.participants[0] : ticket.participants;
      const category = Array.isArray(item?.ticket_categories) ? item.ticket_categories[0] : item?.ticket_categories;
      const holderName = participant?.full_name ?? item?.holder_full_name ?? "Sem titular";
      return <Link href={`/ingressos/${ticket.id}`} key={ticket.id} className="block rounded-xl border border-slate-800 p-4 transition hover:border-emerald-500/40">
        <p className="font-medium">{holderName}</p><p className="text-sm text-slate-400">{category?.name ?? "Sem categoria"} · {ticket.status}</p>
      </Link>;
    })}{!data?.length ? <p className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-slate-400">Nenhum ingresso encontrado.</p> : null}</div>
  </div></div></main>;
}
