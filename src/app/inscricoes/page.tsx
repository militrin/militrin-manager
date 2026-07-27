import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { EmptyState } from "@/components/mvp/EmptyState";
import { Pagination } from "@/components/mvp/Pagination";
import { ParticipantCard } from "@/components/mvp/ParticipantCard";
import { ParticipantsSearchForm } from "./search-form";
import { releaseExpiredReservationsAction } from "./actions";

const PAGE_SIZE = 8;

async function getParticipants(page: number, search: string) {
  await releaseExpiredReservationsAction();

  const supabase = await createServerSupabaseClient();
  const { data: activeEvent } = await supabase.from("events").select("id").eq("is_active", true).maybeSingle();
  if (!activeEvent?.id) return { participants: [], count: 0, totalPages: 1 };

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("participants")
    .select(
      "id, full_name, cpf, phone, city, shirt_type, shirt_size, registration_status, reservation_status, reservation_expires_at, created_at, event_id, base_amount, discount_amount, final_amount, registration_batches:batch_id(name, sequence_number), payments(payment_status, amount, payment_method, paid_at, created_at)",
      { count: "exact" },
    )
    .eq("event_id", activeEvent.id)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (search) {
    const term = search.trim();
    query = query.or(`full_name.ilike.%${term}%,cpf.ilike.%${term}%,phone.ilike.%${term}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const participants = (data ?? []).map((participant) => {
    const payments = Array.isArray(participant.payments) ? participant.payments : [];
    const latestPayment = payments
      .slice()
      .sort((a, b) => new Date(String(b.created_at ?? 0)).getTime() - new Date(String(a.created_at ?? 0)).getTime())[0] ?? null;

    const batch = !Array.isArray(participant.registration_batches) ? participant.registration_batches : participant.registration_batches[0] ?? null;

    return {
      id: String(participant.id),
      registration_number: null,
      full_name: String(participant.full_name),
      cpf: String(participant.cpf),
      phone: String(participant.phone),
      city: participant.city as string | null,
      shirt_type: String(participant.shirt_type),
      shirt_size: String(participant.shirt_size),
      base_amount: Number(participant.base_amount ?? 0),
      discount_amount: Number(participant.discount_amount ?? 0),
      final_amount: Number(participant.final_amount ?? 0),
      payment_status: String(latestPayment?.payment_status ?? "pending"),
      registration_status: String(participant.registration_status ?? "pending"),
      reservation_status: String(participant.reservation_status ?? "pending"),
      reservation_expires_at: participant.reservation_expires_at as string | null,
      batch_name: batch?.name ? String(batch.name) : "Sem lote",
      batch_sequence_number: typeof batch?.sequence_number === "number" ? batch.sequence_number : null,
      created_at: String(participant.created_at),
      kit_status: "pending",
    };
  });

  return { participants, count: count ?? 0, totalPages: Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE)) };
}

export default async function ParticipantsPage({ searchParams }: { searchParams: Promise<{ page?: string; search?: string }> }) {
  const params = await searchParams;
  const page = Number(params.page ?? 1);
  const search = params.search ?? "";
  const { participants, totalPages } = await getParticipants(page, search);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Inscritos" subtitle="Lista de participantes e pagamentos" />
          <SectionCard title="Busca e gestão" description="Pesquise inscritos, acompanhe pagamentos e abra os detalhes.">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <ParticipantsSearchForm initialSearch={search} />
              <Link href="/inscricoes/nova" className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950">Nova inscrição</Link>
            </div>
            {participants.length === 0 ? (
              <div className="mt-6"><EmptyState title="Nenhum inscrito encontrado" description="Ajuste os filtros ou crie uma nova inscrição." /></div>
            ) : (
              <div className="mt-6 grid gap-4">
                {participants.map((participant) => (
                  <ParticipantCard key={participant.id} participant={participant} />
                ))}
              </div>
            )}
            <div className="mt-6">
              <Pagination page={page} totalPages={totalPages} onPageChange={(nextPage) => {
                const params = new URLSearchParams();
                if (search) params.set("search", search);
                params.set("page", String(nextPage));
                window.location.href = `/inscricoes?${params.toString()}`;
              }} />
            </div>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
