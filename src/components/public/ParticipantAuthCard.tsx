import Image from 'next/image';
import Link from 'next/link';
import { CircleUserRound, QrCode, ShoppingBag } from 'lucide-react';
import { PublicLoginForm } from './PublicLoginForm';
import { PublicSiteFooter } from './PublicSiteFooter';

type ParticipantAuthCardProps = {
  title?: string;
  subtitle?: string;
  defaultNext?: string;
};

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';

const highlights = [
  { title: 'Compras', text: 'Acompanhe pedidos, pagamentos e reservas.', icon: ShoppingBag },
  { title: 'Acessos', text: 'Abra o QR de retirada do kit e baixe o Event Pass.', icon: QrCode },
  { title: 'Perfil', text: 'Edite seus dados e preferências em um só lugar.', icon: CircleUserRound },
] as const;

export function ParticipantAuthCard({
  title = 'Entre na sua conta',
  subtitle = 'Acesse seus pacotes, compras, pagamentos e todas as informações do evento em um só lugar.',
  defaultNext = '/minha-conta',
}: ParticipantAuthCardProps) {
  return (
    <main className="public-landing font-sans relative isolate flex min-h-[100svh] flex-col overflow-x-hidden bg-[#020617] text-slate-100">
      <Image
        src="/landing/evento-card.webp"
        alt=""
        fill
        priority
        sizes="100vw"
        className="scale-125 object-cover object-[78%_center] opacity-30 blur-[16px]"
      />
      <div aria-hidden className="absolute inset-0 bg-[linear-gradient(105deg,rgba(2,6,23,0.96)_0%,rgba(2,6,23,0.82)_48%,rgba(2,6,23,0.55)_100%)]" />
      <div aria-hidden className="landing-hero-glow absolute inset-0 bg-[radial-gradient(ellipse_at_80%_20%,rgba(16,185,129,0.18),transparent_46%)]" />
      <div aria-hidden className="landing-grain absolute inset-0" />

      <section className="relative z-10 mx-auto flex w-full max-w-[1200px] flex-1 flex-col justify-center px-4 py-8 sm:px-8">
        <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
          <div className="hidden min-w-0 lg:block">
            <Link href="/" className={`inline-flex items-center gap-3 ${focusRing}`}>
              <div className="relative h-10 w-11 shrink-0">
                <div aria-hidden className="mask-logo absolute inset-0 !bg-emerald-400" />
              </div>
              <span>
                <span className="block text-sm font-semibold tracking-[0.28em] text-white">MILITRIN</span>
                <span className="text-[10px] uppercase tracking-[0.16em] text-slate-400">Amizade · Tradição · Oktoberfest</span>
              </span>
            </Link>
            <h1 className="mt-8 text-4xl font-semibold leading-[1.05] tracking-tight text-white xl:text-5xl">
              {title} <span className="text-emerald-400">Militrin</span>
            </h1>
            <p className="mt-4 max-w-md text-sm leading-6 text-slate-300">{subtitle}</p>
            <div className="mt-8 grid max-w-xl grid-cols-3 gap-3">
              {highlights.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="rounded-2xl border border-white/8 bg-black/25 p-4">
                    <Icon size={22} strokeWidth={1.7} className="text-emerald-300" />
                    <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-white">{item.title}</p>
                    <p className="mt-1.5 text-xs leading-5 text-slate-400">{item.text}</p>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mx-auto w-full max-w-md lg:mx-0">
            <Link href="/" className={`mb-6 flex items-center gap-3 lg:hidden ${focusRing}`}>
              <div className="relative h-9 w-10 shrink-0">
                <div aria-hidden className="mask-logo absolute inset-0 !bg-emerald-400" />
              </div>
              <span className="text-sm font-semibold tracking-[0.28em] text-white">MILITRIN</span>
            </Link>
            <div className="rounded-[1.7rem] border border-white/10 bg-[#07111f]/88 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-sm sm:p-7">
              <h2 className="text-xl font-semibold tracking-tight text-white">Bem-vindo de volta!</h2>
              <p className="mt-1 text-sm text-slate-400">Entre com seu e-mail para acessar o portal.</p>
              <div className="mt-6">
                <PublicLoginForm defaultNext={defaultNext} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="relative z-10 px-4 sm:px-8">
        <PublicSiteFooter />
      </div>
    </main>
  );
}
