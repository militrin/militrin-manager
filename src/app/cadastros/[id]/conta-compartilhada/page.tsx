import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { requireAnyPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { loadSharedEmailGroup } from "@/lib/account/load-shared-email-group";
import { SharedEmailAccountManageForm } from "../../shared-email-account-manage-form";

export default async function SharedEmailAccountPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAnyPermission(["participants.edit_basic", "tickets.transfer_ownership"]);
  const { id } = await params;
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) notFound();
  const supabase = await createServerSupabaseClient();
  const [{ data: contact }, group] = await Promise.all([
    supabase.from("registration_contacts").select("id,full_name,email").eq("id", id).eq("organization_id", organization.id).maybeSingle(),
    loadSharedEmailGroup(supabase, organization.id, id),
  ]);
  if (!contact) notFound();

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto flex max-w-7xl gap-6">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-6">
          <TopBar
            title="Gerenciar conta e ingressos"
            subtitle={String(contact.full_name)}
            breadcrumbs={[
              { label: "Início", href: "/painel" },
              { label: "Cadastros", href: "/cadastros" },
              { label: String(contact.full_name), href: `/cadastros/${id}` },
              { label: "Conta compartilhada" },
            ]}
            backHref={`/cadastros/${id}`}
            fallbackHref="/cadastros"
          />
          {!group ? (
            <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
              <p className="text-sm text-slate-300">Este cadastro não compartilha e-mail com outra Pessoa.</p>
              <Link href={`/cadastros/${id}`} className="mt-4 inline-flex rounded-xl border border-slate-700 px-4 py-2 text-sm">Voltar à ficha</Link>
            </section>
          ) : (
            <section className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-200">E-mail compartilhado</p>
              <h2 className="mt-2 text-xl font-semibold">E-mail compartilhado por {group.peopleCount} cadastros</h2>
              <p className="mt-1 text-sm text-slate-400">{group.email} · {group.ticketCount} ingresso(s)</p>
              <div className="mt-6">
                <SharedEmailAccountManageForm group={group} />
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
