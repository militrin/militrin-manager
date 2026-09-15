import type { ReactNode } from 'react';
import {
  CalendarDays,
  ChevronRight,
  CircleUserRound,
  Home,
  Info,
  MoreHorizontal,
  ShoppingBag,
} from 'lucide-react';
import { cx } from '@/components/militrin/utils';

function IllustrationQr({ className }: { className?: string }) {
  const cells: Array<{ x: number; y: number }> = [];
  const size = 25;

  function addFinder(ox: number, oy: number) {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const border = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (border || core) cells.push({ x: ox + x, y: oy + y });
      }
    }
  }

  addFinder(1, 1);
  addFinder(size - 8, 1);
  addFinder(1, size - 8);

  let seed = 20261010;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inFinder =
        (x < 9 && y < 9) || (x >= size - 9 && y < 9) || (x < 9 && y >= size - 9);
      if (inFinder) continue;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      if (seed % 5 < 2) cells.push({ x, y });
    }
  }

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={className} aria-hidden>
      <rect width={size} height={size} fill="#f8fafc" rx="1" />
      {cells.map((cell) => (
        <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width="1" height="1" fill="#0b1220" />
      ))}
    </svg>
  );
}

function PhoneChrome({
  children,
  compact,
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cx('landing-phone', compact ? 'landing-phone-secondary' : 'landing-phone-main')}>
      <div className="landing-phone-screen">
        <div className="landing-phone-notch" />
        {children}
      </div>
    </div>
  );
}

function PhoneAccess() {
  return (
    <PhoneChrome>
      <div className="flex h-full flex-col px-3.5 pb-3 pt-8">
        <p className="text-[9px] font-semibold uppercase tracking-[0.32em] text-emerald-300">Militrin</p>
        <p className="mt-2 text-[1.25rem] font-semibold leading-none tracking-tight text-white">Olá, Participante!</p>
        <p className="mt-1 text-[11px] text-slate-400">Aqui está o seu acesso e compras.</p>
        <div className="mt-3 rounded-2xl border border-emerald-400/20 bg-[#07111f] p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 text-[12px] font-semibold leading-tight text-white">Pacote Militrin 2026</p>
            <span className="shrink-0 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[9px] font-semibold text-emerald-300">Ativo</span>
          </div>
          <div className="mx-auto mt-2.5 w-[108px] rounded-xl bg-white p-1.5">
            <IllustrationQr className="h-full w-full" />
          </div>
          <p className="mt-1.5 text-center text-[9px] leading-4 text-slate-400">QR Code de acesso para retirada do kit</p>
          <p className="mt-2 rounded-xl bg-emerald-400/12 py-1.5 text-center text-[11px] font-semibold text-emerald-200">Ver detalhes</p>
        </div>
        <div className="mt-3 space-y-1">
          {[
            { label: 'Minhas compras', hint: '2 pedidos', icon: ShoppingBag },
            { label: 'Meus dados', hint: 'Editar informações', icon: CircleUserRound },
            { label: 'Informações do evento', hint: 'Programação, orientações e mais', icon: Info },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="flex items-center gap-2 rounded-xl px-1 py-1.5">
                <Icon size={14} className="text-emerald-300" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-medium text-slate-200">{item.label}</span>
                  <span className="block text-[9px] text-slate-500">{item.hint}</span>
                </span>
                <ChevronRight size={12} className="text-slate-600" />
              </div>
            );
          })}
        </div>
        <div className="mt-auto grid grid-cols-4 border-t border-white/8 pt-2 text-center text-[8px] text-slate-500">
          <span className="text-emerald-300"><Home size={13} className="mx-auto mb-0.5" />Início</span>
          <span><ShoppingBag size={13} className="mx-auto mb-0.5" />Compras</span>
          <span><CalendarDays size={13} className="mx-auto mb-0.5" />Eventos</span>
          <span><MoreHorizontal size={13} className="mx-auto mb-0.5" />Mais</span>
        </div>
      </div>
    </PhoneChrome>
  );
}

function PhonePurchases() {
  return (
    <PhoneChrome compact>
      <div className="flex h-full flex-col px-3.5 pb-3 pt-8">
        <p className="text-[9px] font-semibold uppercase tracking-[0.32em] text-emerald-300">Militrin</p>
        <p className="mt-2 text-base font-semibold tracking-tight text-white">Minhas compras</p>
        <div className="mt-3 flex gap-1.5 text-[9px]">
          <span className="rounded-full bg-emerald-400/15 px-2 py-1 font-medium text-emerald-200">Todos (2)</span>
          <span className="rounded-full bg-white/5 px-2 py-1 text-slate-400">Ingressos (1)</span>
          <span className="rounded-full bg-white/5 px-2 py-1 text-slate-400">Loja (1)</span>
        </div>
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2.5 rounded-2xl border border-white/8 bg-[#07111f] p-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400/15 text-[15px] text-emerald-200">M</div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-white">Camiseta Militrin 2026</p>
              <p className="text-[10px] text-slate-400">Pacote · 1 unidade</p>
            </div>
            <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[9px] font-medium text-emerald-300">Confirmado</span>
          </div>
          <div className="flex items-center gap-2.5 rounded-2xl border border-white/8 bg-[#07111f] p-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/8 text-[15px] text-slate-200">C</div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-white">Copo oficial</p>
              <p className="text-[10px] text-slate-400">Loja Militrin · 1 unidade</p>
            </div>
            <span className="rounded-full bg-sky-400/15 px-2 py-0.5 text-[9px] font-medium text-sky-200">Loja</span>
          </div>
        </div>
        <p className="mt-4 text-center text-[11px] font-medium text-emerald-300">Ver todos os pedidos</p>
      </div>
    </PhoneChrome>
  );
}

export function LandingPhones() {
  return (
    <div className="relative mx-auto h-[340px] w-full max-w-[34rem] sm:h-[430px] lg:h-[540px]" aria-hidden>
      <div className="landing-hero-glow pointer-events-none absolute left-1/2 top-8 h-72 w-72 -translate-x-1/2 rounded-full bg-emerald-400/20 blur-3xl" />
      <div className="absolute left-1/2 top-0 z-20 -translate-x-1/2 lg:left-[46%] lg:top-2 lg:-translate-x-[86%]">
        <PhoneAccess />
      </div>
      <div className="absolute left-1/2 top-12 z-10 hidden -translate-x-[2%] lg:block">
        <PhonePurchases />
      </div>
    </div>
  );
}
