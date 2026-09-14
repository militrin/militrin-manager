import Image from 'next/image';
import Link from 'next/link';
import { ChevronRight, ShoppingBag } from 'lucide-react';

export type HomeStoreHighlight = {
  id: string;
  name: string;
  imageUrl: string;
};

export function HomeStoreBanner({
  imageUrls,
  products = [],
}: {
  imageUrls: string[];
  products?: HomeStoreHighlight[];
}) {
  const visuals = products.length > 0 ? products : imageUrls.map((url, index) => ({ id: `${index}`, name: '', imageUrl: url }));

  return (
    <Link
      href="/minha-conta/loja"
      className="group relative isolate flex min-h-0 overflow-hidden rounded-[1.25rem] border border-slate-800/80 bg-gradient-to-r from-slate-950 via-slate-900 to-emerald-950/40 shadow-lg shadow-black/20 transition hover:border-emerald-500/35 sm:rounded-[1.5rem] lg:min-h-[7.5rem]"
    >
      <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 sm:gap-3 sm:p-4 lg:gap-3 lg:px-4 lg:py-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/10 text-emerald-300 sm:h-11 sm:w-11 sm:rounded-2xl">
          <ShoppingBag size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold tracking-tight text-white sm:text-base">Loja Militrin</span>
          <span className="mt-0.5 block truncate text-[11px] text-slate-400 sm:text-sm">Copos, camisetas e produtos exclusivos.</span>
          <span className="mt-2 inline-flex h-8 items-center gap-1 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-100 transition group-hover:border-emerald-300/50 sm:h-9 sm:rounded-2xl sm:text-sm">
            Ver loja
            <ChevronRight size={13} />
          </span>
        </span>
      </div>
      {visuals.length > 0 ? (
        <div aria-hidden className="relative flex w-[42%] max-w-[13.5rem] items-center justify-end gap-1.5 pr-2 sm:w-[38%] sm:max-w-xs sm:gap-2 sm:pr-4 lg:max-w-none lg:w-[46%]">
          {visuals.slice(0, 3).map((item, index) => (
            <div
              key={`${item.id}-${item.imageUrl}`}
              className="relative h-14 w-11 overflow-hidden rounded-lg border border-white/10 bg-slate-900 shadow-lg sm:h-20 sm:w-16 sm:rounded-xl lg:h-[5.5rem] lg:w-[4.25rem]"
              style={{ transform: `rotate(${index === 1 ? -8 : index === 2 ? 7 : 3}deg)` }}
            >
              <Image src={item.imageUrl} alt="" fill unoptimized className="object-cover" />
            </div>
          ))}
        </div>
      ) : null}
    </Link>
  );
}
