import { notFound } from "next/navigation";
import { SorteiosShell } from "@/components/sorteios/SorteiosShell";
import { SorteioApp } from "@/components/sorteios/SorteioApp";
import { requireAdministrativePanelAccess } from "@/lib/admin/panel-access";
import { getInstagramStatus } from "../instagram-actions";
import { loadGiveawaySession } from "../giveaway-actions";

export default async function SorteioDetalhePage({
  params,
}: {
  params: Promise<{ giveawayId: string }>;
}) {
  await requireAdministrativePanelAccess();
  const { giveawayId } = await params;
  const [bootstrap, instagramStatus] = await Promise.all([
    loadGiveawaySession(giveawayId),
    getInstagramStatus(),
  ]);
  if (bootstrap.persistence === "available" && !bootstrap.session) notFound();

  return (
    <SorteiosShell title={bootstrap.session?.name ?? "Sorteio"} subtitle={bootstrap.session?.id}>
      <SorteioApp
        initialSession={bootstrap.session}
        persistenceAvailable={bootstrap.persistence === "available"}
        initialInstagramStatus={instagramStatus}
      />
    </SorteiosShell>
  );
}
