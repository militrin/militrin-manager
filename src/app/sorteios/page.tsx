import { InstagramOAuthFeedback } from "@/components/sorteios/InstagramOAuthFeedback";
import { GiveawayHub } from "@/components/sorteios/GiveawayHub";
import { SorteiosShell } from "@/components/sorteios/SorteiosShell";
import { requireAdministrativePanelAccess } from "@/lib/admin/panel-access";
import { getInstagramStatus } from "./instagram-actions";
import { listGiveaways } from "./giveaway-actions";

export default async function SorteiosPage({
  searchParams,
}: {
  searchParams: Promise<{ instagram?: string; reason?: string }>;
}) {
  await requireAdministrativePanelAccess();
  const [list, instagramStatus, params] = await Promise.all([
    listGiveaways(),
    getInstagramStatus(),
    searchParams,
  ]);

  return (
    <SorteiosShell title="Sorteios" subtitle="Central de sorteios reutilizável. O sorteio oficial permanece intacto.">
      <InstagramOAuthFeedback instagram={params.instagram} reason={params.reason} />
      <GiveawayHub
        items={list.items}
        instagramStatus={instagramStatus}
      />
    </SorteiosShell>
  );
}
