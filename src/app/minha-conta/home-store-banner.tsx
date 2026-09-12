import Image from 'next/image';
import Link from 'next/link';
import { ChevronRight, ShoppingBag } from 'lucide-react';

export function HomeStoreBanner({
  imageUrls,
}: {
  imageUrls: string[];
}) {
  return (
    <Link
      href="/minha-conta/loja"
      className="group relative isolate flex overflow-hidden rounded-[1.5rem] border border-slate-800/80 bg-gradient-to-r from-slate-950 via-slate-900 to-emerald-950/40 shadow-lg shadow-black/20 transition hover:border-emerald-500/35"
    >
      <div className="relative z-10 flex min-w-0 flex-1 items-center gap-3 p-4 sm:p-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-500/10 text-emerald-300">
          <ShoppingBag size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold tracking-tight text-white">Loja Militrin</span>
          <span className="mt-0.5 block truncate text-sm text-slate-400">Copos, camisetas e produtos exclusivos.</span>
        </span>
        <span className="inline-flex h-11 shrink-0 items-center gap-1 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 px-3.5 text-sm font-semibold text-emerald-100 transition group-hover:border-emerald-300/50">
          Ver loja
          <ChevronRight size={14} />
        </span>
      </div>
      {imageUrls.length > 0 ? (
        <div aria-hidden className="relative hidden w-[38%] max-w-xs items-center justify-end gap-2 pr-4 lg:flex">
          {imageUrls.slice(0, 3).map((url, index) => (
            <div
              key={`${url}-${index}`}
              className="relative h-20 w-16 overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-lg"
              style={{ transform: `rotate(${index === 1 ? -8 : index === 2 ? 7 : 3}deg)` }}
            >
              <Image src={url} alt="" fill unoptimized className="object-cover" />
            </div>
          ))}
        </div>
      ) : null}
    </Link>
  );
}
