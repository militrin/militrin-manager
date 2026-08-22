import { PublicBrandMark } from './PublicBrandMark';
import { PublicLoginForm } from './PublicLoginForm';

type ParticipantAuthCardProps = {
  title?: string;
  subtitle?: string;
  defaultNext?: string;
};

// Mesma casca visual da home publica (/): gradiente com --brand-glow (segue
// o brand_theme da plataforma), mesmo container/card, mesma marca e o mesmo
// PublicLoginForm usado la -- /entrar e a home precisam continuar sendo a
// mesma identidade de produto, so que esta pagina e focada em login.
export function ParticipantAuthCard({
  title = 'Entrar',
  subtitle = 'Acesse suas compras, ingressos e dados do usuário.',
  defaultNext = '/minha-conta',
}: ParticipantAuthCardProps) {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-6xl rounded-[2rem] border border-slate-800/70 bg-slate-950/65 p-6 shadow-2xl shadow-black/20 sm:p-10">
        <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
          <div className="space-y-5">
            <PublicBrandMark />
            <h1 className="text-3xl font-semibold text-white sm:text-5xl">{title}</h1>
            <p className="max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">{subtitle}</p>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Compras</p>
                <p className="mt-2 text-sm text-slate-200">Acompanhe pedidos, pagamentos e reservas.</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Ingressos</p>
                <p className="mt-2 text-sm text-slate-200">Abra seus QR codes e baixe os comprovantes.</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Perfil</p>
                <p className="mt-2 text-sm text-slate-200">Edite seus dados e preferências em um só lugar.</p>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5 sm:p-6">
            <h2 className="text-lg font-semibold text-white">Entrar na minha conta</h2>
            <p className="mt-1 text-xs text-slate-400">Entre com seu e-mail para acessar o portal.</p>

            <div className="mt-4">
              <PublicLoginForm defaultNext={defaultNext} />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
