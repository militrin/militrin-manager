import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { MilitrinSection, MilitrinStatusBadge } from '@/components/militrin';
import { SponsorBannerForm } from './sponsor-banner-form';

// Guard no backend, nao so escondendo o link na sidebar: get_my_sponsor_profile
// so retorna uma linha quando sponsors.user_id = auth.uid(), entao um usuario
// comum que digitar esta URL direto cai aqui sem nenhum dado e e redirecionado.
export default async function SponsorAreaPage() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_my_sponsor_profile');
  const profile = (Array.isArray(data) ? data[0] : data) as {
    sponsor_id: string;
    organization_name: string;
    name: string;
    banner_url: string | null;
    link_url: string | null;
    is_active: boolean;
  } | undefined;

  if (error || !profile) {
    redirect('/minha-conta');
  }

  return (
    <MilitrinSection
      eyebrow={profile.organization_name}
      title="Área do patrocinador"
      description={`Gerencie o banner de "${profile.name}" exibido em rotação na Home dos usuários.`}
      action={<MilitrinStatusBadge status={profile.is_active ? 'active' : 'cancelled'} label={profile.is_active ? 'Ativo' : 'Inativo'} />}
    >
      {!profile.is_active ? (
        <p className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Seu patrocínio está inativo no momento. O banner não será exibido na Home até a organização reativá-lo.
        </p>
      ) : null}
      <SponsorBannerForm
        sponsorId={profile.sponsor_id}
        sponsorName={profile.name}
        initialBannerUrl={profile.banner_url}
        initialLinkUrl={profile.link_url}
      />
    </MilitrinSection>
  );
}
