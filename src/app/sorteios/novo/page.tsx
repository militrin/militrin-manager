import Link from "next/link";
import { SorteiosShell } from "@/components/sorteios/SorteiosShell";
import { GiveawayCreateForm } from "@/components/sorteios/GiveawayCreateForm";
import { requireAdministrativePanelAccess } from "@/lib/admin/panel-access";
import { getInstagramStatus } from "../instagram-actions";

export default async function NovoSorteioPage() {
  await requireAdministrativePanelAccess();
  const instagramStatus = await getInstagramStatus();
  return (
    <SorteiosShell
      title="Novo sorteio"
      subtitle="Crie um rascunho sem alterar sorteios já existentes."
      actions={<Link href="/sorteios" className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Voltar</Link>}
    >
      <GiveawayCreateForm instagramStatus={instagramStatus} />
    </SorteiosShell>
  );
}
