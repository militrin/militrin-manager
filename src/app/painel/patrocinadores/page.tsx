import { requirePermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { MilitrinSection } from '@/components/militrin';
import { SponsorsManager } from './sponsors-manager';
import { listSponsorsForAdminAction } from './actions';

export default async function PatrocinadoresPage() {
  await requirePermission('sponsors.view');

  const supabase = await createServerSupabaseClient();
  const [sponsorsResult, orgIdResult] = await Promise.all([
    listSponsorsForAdminAction(),
    supabase.rpc('current_organization_id'),
  ]);
  const orgId = orgIdResult.data as string | null;
  const orgResult = orgId
    ? await supabase.from('organizations').select('sponsor_carousel_interval_seconds, sponsor_carousel_order_mode').eq('id', orgId).maybeSingle()
    : { data: null };
  const orgRow = orgResult.data as { sponsor_carousel_interval_seconds: number; sponsor_carousel_order_mode: 'random' | 'manual' } | null;
  const carouselIntervalSeconds = Number(orgRow?.sponsor_carousel_interval_seconds ?? 4);
  const carouselOrderMode = orgRow?.sponsor_carousel_order_mode ?? 'random';

  return (
    <MilitrinSection
      eyebrow="Organização"
      title="Patrocinadores"
      description="Marcas parceiras exibidas em rotação na Home dos usuários. Cada patrocinador pode ter no máximo um banner ativo."
    >
      <SponsorsManager
        initialSponsors={sponsorsResult.success ? sponsorsResult.sponsors : []}
        initialCarouselIntervalSeconds={carouselIntervalSeconds}
        initialCarouselOrderMode={carouselOrderMode}
      />
    </MilitrinSection>
  );
}
