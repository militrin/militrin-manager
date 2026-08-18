import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { CouponsManager } from "./ui";

type CouponRow = {
  id: string;
  code: string;
  discount_type: "percentage" | "fixed";
  discount_value: number;
  applies_to_tickets: boolean;
  applies_to_products: boolean;
  max_uses: number | null;
  used_count: number;
  valid_from: string | null;
  valid_until: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
};

async function getCouponsData(organizationId: string) {
  const supabase = await createServerSupabaseClient();
  const { data: coupons, error } = await supabase
    .from("coupons")
    .select("id, code, discount_type, discount_value, applies_to_tickets, applies_to_products, max_uses, used_count, valid_from, valid_until, is_active, notes, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (coupons ?? []) as CouponRow[];
}

export default async function CouponsPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/entrar?next=/cupons");

  const currentOrganization = (await getCurrentOrganizationContext()).organization;
  if (!currentOrganization?.id) redirect("/painel");

  const coupons = await getCouponsData(currentOrganization.id);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow-strong),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Cupons" subtitle="Descontos e cortesias da organização — ingressos e/ou produtos da loja" />
          <SectionCard title="Gestão de cupons" description="O cupom pertence à organização. O escopo (quais eventos, categorias e produtos) é configurado em cada cupom.">
            <CouponsManager organizationId={currentOrganization.id} coupons={coupons} />
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
