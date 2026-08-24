import Link from "next/link";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { CouponsManager } from "./ui";
import { getCurrentPermissionMap } from "@/lib/admin/permissions";

export type CouponStatusFilter = "active" | "inactive" | "archived";

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
  archived_at: string | null;
  has_usage: boolean;
};

function parseStatusFilter(value: string | undefined): CouponStatusFilter {
  return value === "inactive" || value === "archived" ? value : "active";
}

async function getCouponsData(organizationId: string, status: CouponStatusFilter) {
  const supabase = await createServerSupabaseClient();
  const { data: coupons, error } = await supabase.rpc("list_organization_coupons", {
    p_organization_id: organizationId,
    p_status: status,
  });
  if (error) throw error;
  return (coupons ?? []) as CouponRow[];
}

const STATUS_TABS: Array<{ value: CouponStatusFilter; label: string }> = [
  { value: "active", label: "Ativos" },
  { value: "inactive", label: "Inativos" },
  { value: "archived", label: "Arquivados" },
];

export default async function CouponsPage({ searchParams }: { searchParams?: Promise<{ status?: string }> }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/entrar?next=/cupons");

  const currentOrganization = (await getCurrentOrganizationContext()).organization;
  if (!currentOrganization?.id) redirect("/painel");

  const resolvedSearchParams = searchParams ? await searchParams : {};
  const status = parseStatusFilter(resolvedSearchParams.status);
  const [coupons, permissions] = await Promise.all([
    getCouponsData(currentOrganization.id, status),
    getCurrentPermissionMap(["coupons.create", "coupons.edit", "coupons.disable"]),
  ]);
  const canManage = Object.values(permissions).some(Boolean);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow-strong),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Cupons" subtitle="Descontos e cortesias da organização — ingressos e/ou produtos da loja" />
          <SectionCard title="Gestão de cupons" description="O cupom pertence à organização. O escopo (quais eventos, categorias e produtos) é configurado em cada cupom.">
            <div className="mb-4 flex gap-2">
              {STATUS_TABS.map((tab) => (
                <Link
                  key={tab.value}
                  href={tab.value === "active" ? "/cupons" : `/cupons?status=${tab.value}`}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium ${
                    status === tab.value ? "border-emerald-500 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-300"
                  }`}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
            {canManage ? <CouponsManager organizationId={currentOrganization.id} coupons={coupons} status={status} /> : (
              <div className="space-y-2">{coupons.map((coupon) => (
                <div key={coupon.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm">
                  <p className="font-mono font-semibold text-slate-100">{coupon.code}</p>
                  <p className="text-xs text-slate-400">{coupon.discount_type === "percentage" ? `${coupon.discount_value}%` : `R$ ${coupon.discount_value.toFixed(2)}`} · {coupon.used_count} uso(s) · {coupon.is_active ? "Ativo" : "Inativo"}</p>
                </div>
              ))}</div>
            )}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
