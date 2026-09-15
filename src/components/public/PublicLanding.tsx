import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  CalendarDays,
  CircleUserRound,
  Headphones,
  Info,
  Mail,
  MapPin,
  QrCode,
  Shield,
  ShoppingBag,
  Smartphone,
  UserPlus,
  Users,
} from 'lucide-react';
import { LandingPhones } from '@/components/public/LandingPhones';
import { PublicSiteFooter } from '@/components/public/PublicSiteFooter';
import {
  MILITRIN_PARTICIPANT_COPY,
  OKTOBERFEST_ACCESS_NOTICE,
} from '@/lib/public/oktoberfest-access-notice';
import {
  getMilitrinContactEmail,
  MILITRIN_INSTAGRAM_URL,
} from '@/lib/public/legal';
import {
  EVENT_TIMEZONE,
  dateTimePartsInEventTimeZone,
  formatDateLongBR,
  parseDateInput,
} from '@/lib/utils/date';

export const PUBLIC_LOGIN_PATH = '/entrar';
export const PUBLIC_SIGNUP_PATH = '/criar-conta';
export const FORGOT_PASSWORD_PATH = '/esqueci-minha-senha';
export const LANDING_SHOW_ART = '/landing/evento-card.webp';

export type PublicLandingEvent = {
  name: string;
  year: number | null;
  slug: string;
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  description: string | null;
  bannerHeroUrl: string | null;
  bannerCardUrl: string | null;
} | null;

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';
const primaryCtaClass = `inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 motion-reduce:transition-none ${focusRing}`;
const secondaryCtaClass = `inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/20 bg-white/5 px-5 text-sm font-semibold text-white transition hover:border-emerald-400/50 hover:bg-white/10 motion-reduce:transition-none ${focusRing}`;

const highlights = [
  { href: `${PUBLIC_LOGIN_PATH}?next=/minha-conta/ingressos`, title: 'Meu acesso', text: `${MILITRIN_PARTICIPANT_COPY.qrForKitPickup} e informações do seu pacote.`, icon: QrCode },
  { href: `${PUBLIC_LOGIN_PATH}?next=/minha-conta/compras`, title: 'Minhas compras', text: 'Acompanhe seus pedidos da Loja Militrin.', icon: ShoppingBag },
  { href: `${PUBLIC_LOGIN_PATH}?next=/minha-conta/dados`, title: 'Meus dados', text: 'Veja e atualize suas informações.', icon: CircleUserRound },
  { href: '#informacoes', title: 'Informações', text: 'Programação, orientações e novidades do evento.', icon: Info },
] as const;

const faqItems = [
  {
    question: 'Como acesso meu QR Code?',
    answer: 'Entre na sua conta e abra Meus acessos. O QR Code do Pacote Militrin é para retirada do kit no evento — não substitui o ingresso da Oktoberfest.',
  },
  {
    question: 'O QR Code é o ingresso da Oktoberfest?',
    answer: OKTOBERFEST_ACCESS_NOTICE.full,
  },
  {
    question: 'Ainda não tenho conta. O que faço?',
    answer: 'Use Criar minha conta. Depois de autenticado, a compra do Pacote Militrin aparece em Minha conta quando as vendas estiverem abertas.',
  },
  {
    question: 'Já tenho conta. Como entro?',
    answer: 'Use Acessar minha conta. Se esqueceu a senha, use Esqueci minha senha na tela de login.',
  },
  {
    question: 'Já comprei, mas nunca criei senha. O que faço?',
    answer: 'Se você recebeu um e-mail de acesso ou convite, use esse link para ativar a conta que já existe no sistema. Isso não é o mesmo que Criar minha conta.',
  },
  {
    question: 'Onde vejo minhas compras?',
    answer: 'Na sua conta, em Minhas compras: pedidos, produtos da Loja e status de pagamento.',
  },
  {
    question: 'Não recebi o e-mail de acesso.',
    answer: 'Confira a caixa de spam. Se já tem senha, recupere em Esqueci minha senha. Se recebeu um convite e o e-mail não chegou, fale pelos canais oficiais abaixo com o mesmo e-mail da compra.',
  },
  {
    question: 'Preciso imprimir o QR Code?',
    answer: 'Não. O QR fica na sua conta, no celular, para a retirada do kit. Imprimir é opcional.',
  },
] as const;

function formatHourLabel(hour: string, minute: string) {
  return Number(minute) ? `${hour}h${minute}` : `${hour}h`;
}

function eventWhen(event: PublicLandingEvent) {
  const start = parseDateInput(event?.startsAt);
  if (!start) {
    return {
      date: '10 de outubro de 2026',
      time: 'Sábado · 13h às 19h30',
    };
  }
  const date = formatDateLongBR(event?.startsAt);
  const weekday = new Intl.DateTimeFormat('pt-BR', {
    timeZone: EVENT_TIMEZONE,
    weekday: 'long',
  }).format(start);
  const weekdayLabel = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  const startParts = dateTimePartsInEventTimeZone(start);
  const end = parseDateInput(event?.endsAt);
  if (!end) {
    return {
      date: date === '-' ? '10 de outubro de 2026' : date,
      time: `${weekdayLabel} · ${formatHourLabel(startParts.hour, startParts.minute)}`,
    };
  }
  const endParts = dateTimePartsInEventTimeZone(end);
  return {
    date: date === '-' ? '10 de outubro de 2026' : date,
    time: `${weekdayLabel} · ${formatHourLabel(startParts.hour, startParts.minute)} às ${formatHourLabel(endParts.hour, endParts.minute)}`,
  };
}

function eventPlace(location: string | null | undefined) {
  const raw = location?.trim() || 'Complexo Oktoberfest';
  if (/itapiranga/i.test(raw)) {
    const [place, rest] = raw.split(/[-–—]/).map((part) => part.trim());
    return {
      place: place || raw,
      city: rest || 'Itapiranga - SC',
    };
  }
  return { place: raw, city: 'Itapiranga - SC' };
}

function BrandMark() {
  return (
    <Link href="#topo" className={`flex min-w-0 items-center gap-3 ${focusRing}`}>
      <div className="relative h-10 w-11 shrink-0">
        <div aria-hidden className="mask-logo absolute inset-0 !bg-emerald-400" />
      </div>
      <span className="min-w-0">
        <span className="block text-sm font-semibold tracking-[0.28em] text-white">MILITRIN</span>
        <span className="hidden text-[10px] uppercase tracking-[0.16em] text-slate-400 sm:block">Amizade · Tradição · Oktoberfest</span>
      </span>
    </Link>
  );
}

export function PublicLanding({ event }: { event: PublicLandingEvent }) {
  const contactEmail = getMilitrinContactEmail();
  const when = eventWhen(event);
  const place = eventPlace(event?.location);
  const eventHref = event?.slug ? `/eventos/${event.slug}` : '/eventos';

  return (
    <main id="topo" className="public-landing font-sans relative isolate overflow-x-hidden bg-[#020617] text-slate-100">
      <section className="relative flex min-h-[100svh] flex-col overflow-hidden">
        <Image
          src={LANDING_SHOW_ART}
          alt=""
          fill
          priority
          sizes="100vw"
          className="scale-125 object-cover object-[78%_center] opacity-35 blur-[14px]"
        />
        <div aria-hidden className="absolute inset-0 bg-[linear-gradient(105deg,rgba(2,6,23,0.96)_0%,rgba(2,6,23,0.78)_42%,rgba(2,6,23,0.45)_100%)]" />
        <div aria-hidden className="landing-hero-glow absolute inset-0 bg-[radial-gradient(ellipse_at_80%_30%,rgba(16,185,129,0.22),transparent_46%)]" />
        <div aria-hidden className="absolute inset-0 bg-[radial-gradient(circle_at_bottom,rgba(0,0,0,0.55),transparent_58%)]" />
        <div aria-hidden className="landing-grain absolute inset-0" />

        <header className="relative z-20 mx-auto flex w-full max-w-[1400px] items-center justify-between gap-3 px-4 pt-[max(0.9rem,calc(var(--safe-top)+0.65rem))] sm:px-8">
          <BrandMark />
          <nav className="hidden items-center gap-8 text-sm text-slate-300 lg:flex">
            <Link href={eventHref} className={`hover:text-white ${focusRing}`}>O Evento</Link>
            <a href="#informacoes" className={`hover:text-white ${focusRing}`}>Dúvidas</a>
            <a href="#contato" className={`hover:text-white ${focusRing}`}>Contato</a>
          </nav>
          <Link href={PUBLIC_LOGIN_PATH} className={`${primaryCtaClass} min-h-10 px-3 text-xs sm:min-h-11 sm:px-5 sm:text-sm`}>
            <CircleUserRound size={15} />
            Acessar minha conta
            <ArrowRight size={14} className="hidden sm:block" />
          </Link>
        </header>

        <div className="relative z-10 mx-auto grid w-full max-w-[1400px] flex-1 items-center gap-5 px-4 py-6 pb-10 sm:px-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-2 lg:py-8">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-emerald-300">Próximo encontro:</p>
            <p className="mt-2 text-[2.35rem] font-semibold leading-[0.92] tracking-tight text-white sm:text-6xl lg:text-[5.1rem]">
              MILITRIN <span className="text-emerald-400">2026</span>
            </p>
            <h1 className="mt-4 max-w-xl text-xl font-medium leading-[1.15] tracking-tight text-white sm:text-3xl">
              Seu acesso ao Militrin em um só lugar.
            </h1>
            <p className="mt-3 max-w-lg text-sm leading-6 text-slate-300 sm:text-base">
              Consulte seu pacote, QR Code, compras e todas as informações do evento de forma simples e segura.
            </p>
            <div className="mt-5 grid max-w-xl gap-3 text-sm text-slate-200 sm:grid-cols-2">
              <p className="flex items-start gap-2.5">
                <CalendarDays size={18} className="mt-0.5 shrink-0 text-emerald-300" />
                <span>
                  <span className="block font-medium text-white">{when.date}</span>
                  <span className="text-xs text-slate-400">{when.time}</span>
                </span>
              </p>
              <p className="flex items-start gap-2.5">
                <MapPin size={18} className="mt-0.5 shrink-0 text-emerald-300" />
                <span>
                  <span className="block font-medium text-white">{place.place}</span>
                  <span className="text-xs text-slate-400">{place.city}</span>
                </span>
              </p>
            </div>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <Link href={PUBLIC_LOGIN_PATH} className={`${primaryCtaClass} w-full sm:w-auto`}>
                <CircleUserRound size={16} />
                Acessar minha conta
                <ArrowRight size={16} />
              </Link>
              <Link href={PUBLIC_SIGNUP_PATH} className={`${secondaryCtaClass} w-full sm:w-auto`}>
                <UserPlus size={16} />
                Criar minha conta
              </Link>
              <Link href={FORGOT_PASSWORD_PATH} className={`inline-flex min-h-11 items-center justify-center px-1 text-sm font-medium text-slate-400 underline-offset-4 hover:text-white hover:underline ${focusRing}`}>
                Esqueci minha senha
              </Link>
            </div>
            <ul className="mt-6 grid grid-cols-3 gap-2 text-[11px] leading-4 text-slate-300 sm:max-w-xl sm:text-[13px] sm:leading-5">
              <li className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2"><Shield size={16} className="text-emerald-300" /> Seguro e confiável</li>
              <li className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2"><Smartphone size={16} className="text-emerald-300" /> Acesse de qualquer lugar</li>
              <li className="flex flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:gap-2"><Users size={16} className="text-emerald-300" /> Feito para nossa comunidade</li>
            </ul>
          </div>
          <div className="relative">
            <LandingPhones />
          </div>
        </div>
      </section>

      <section className="bg-[#07111f] px-4 py-16 sm:px-8">
        <div className="mx-auto w-full max-w-[1400px]">
          <div className="flex items-end justify-between gap-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-emerald-300">Tudo em um só lugar</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">O que você encontra na sua conta</h2>
            </div>
            <p className="hidden max-w-xs text-right text-sm text-slate-400 lg:block">Acesse e tenha tudo na palma da mão.</p>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            {highlights.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.title}
                  href={item.href}
                  className={`rounded-[1.7rem] border border-white/8 bg-[#0b1628] p-5 transition hover:-translate-y-0.5 hover:border-emerald-400/35 hover:bg-[#102036] motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${focusRing}`}
                >
                  <Icon size={38} strokeWidth={1.55} className="text-emerald-300" />
                  <p className="mt-6 text-sm font-semibold uppercase tracking-[0.16em] text-white">{item.title}</p>
                  <p className="mt-2 text-sm leading-5 text-slate-400">{item.text}</p>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section id="informacoes" className="scroll-mt-8 bg-[#020617] px-4 py-16 sm:px-8">
        <div className="mx-auto w-full max-w-[1400px]">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-emerald-300">Dúvidas frequentes</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">Perguntas frequentes</h2>
          <div className="mt-8 grid gap-x-16 md:grid-cols-2">
            {faqItems.map((item) => (
              <details key={item.question} className="group border-b border-white/8">
                <summary className={`flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-4 text-left text-sm font-medium text-white marker:content-none [&::-webkit-details-marker]:hidden ${focusRing}`}>
                  {item.question}
                  <span aria-hidden className="text-lg leading-none text-emerald-300 transition-transform group-open:rotate-45 motion-reduce:transition-none motion-reduce:group-open:rotate-0">+</span>
                </summary>
                <p className="pb-4 text-sm leading-6 text-slate-400">{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section id="contato" className="scroll-mt-8 border-y border-white/8 bg-[#07111f] px-4 py-8 sm:px-8">
        <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <Headphones size={22} className="text-emerald-300" />
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-300">Precisa de ajuda?</p>
              <p className="text-sm text-slate-300">Entre em contato pelos nossos canais oficiais.</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <a href={MILITRIN_INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className={`${secondaryCtaClass} justify-between`}>
              Enviar direct no Instagram
              <ArrowRight size={15} />
            </a>
            <a href={`mailto:${contactEmail}`} className={`${secondaryCtaClass} justify-between`}>
              <span className="inline-flex items-center gap-2"><Mail size={15} />{contactEmail}</span>
            </a>
          </div>
        </div>
      </section>

      <div className="bg-[#020617] px-4 sm:px-8">
        <PublicSiteFooter />
      </div>
    </main>
  );
}
