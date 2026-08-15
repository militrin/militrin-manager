import { Sidebar } from '@/components/dashboard/Sidebar';
import { AdminPageHeader, AdminSection } from '@/components/admin';
import { getBrandTheme } from '@/lib/theme/get-brand-theme';
import { ThemePicker } from './theme-picker';

export default async function ConfigurationPage() {
  const brandTheme = await getBrandTheme();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader title="Configurações" subtitle="Preferências gerais do sistema" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Configurações"}]} backHref="/painel" />

          <AdminSection title="Aparência" description="Escolha a cor de marca usada no painel administrativo e no portal do participante.">
            <ThemePicker initialTheme={brandTheme} />
          </AdminSection>
        </div>
      </div>
    </main>
  );
}
