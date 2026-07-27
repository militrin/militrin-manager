import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { EmptyState } from "@/components/mvp/EmptyState";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { CouponsManager } from "./ui";

type CouponRow = {
  id: string;
  event_id: string;
  code: string;
  coupon_type: "courtesy" | "percentage";
  discount_percent: number;
  max_uses: number | null;
  used_count: number;
  valid_from: string | null;
  valid_until: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type CouponRedemptionRow = {
  id: string;
  coupon_id: string;
  participant_id: string;
  event_id: string;
  original_amount: number;
  discount_amount: number;
  final_amount: number;
  redeemed_at: string;
  participants?: { id?: string | null; full_name?: string | null; cpf?: string | null } | null;
};

async function getCouponsData() {
  const supabase = await createServerSupabaseClient();
  const { data: activeEvent, error: eventError } = await supabase.from("events").select("id, name").eq("is_active", true).maybeSingle();

  if (eventError) throw eventError;
  if (!activeEvent?.id) return { activeEvent: null, coupons: [], redemptions: [] };

  const [{ data: coupons, error: couponsError }, { data: redemptions, error: redemptionsError }] = await Promise.all([
    supabase
      .from("coupons")
      .select("id, event_id, code, coupon_type, discount_percent, max_uses, used_count, valid_from, valid_until, is_active, notes, created_at, updated_at")
      .eq("event_id", activeEvent.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("coupon_redemptions")
      .select("id, coupon_id, participant_id, event_id, original_amount, discount_amount, final_amount, redeemed_at, participants(id, full_name, cpf)")
      .eq("event_id", activeEvent.id)
      .order("redeemed_at", { ascending: false })
      .limit(200),
  ]);

  if (couponsError) throw couponsError;
  if (redemptionsError) throw redemptionsError;

  return {
    activeEvent,
    coupons: (coupons ?? []) as CouponRow[],
    redemptions: (redemptions ?? []) as CouponRedemptionRow[],
  };
}

export default async function CouponsPage() {
  const { activeEvent, coupons, redemptions } = await getCouponsData();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Cupons" subtitle="Cortesias e descontos por evento" />
          <SectionCard title="Gestão de cupons" description="Crie, edite, ative e acompanhe utilizações de códigos promocionais.">
            {!activeEvent?.id ? (
              <EmptyState title="Nenhum evento ativo" description="Ative um evento para gerenciar cupons." />
            ) : (
              <CouponsManager eventId={activeEvent.id} coupons={coupons} redemptions={redemptions} />
            )}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
