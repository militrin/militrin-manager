import Image from 'next/image';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

export function HomeStoreBanner({
  imageUrls,
}: {
  imageUrls: string[];
}) {
  return (
    <Link
      href="/minha-conta/loja"
      className="relative isolate flex min-h-24 overflow-hidden rounded-[1.75rem] border border-slate-800/80 bg-slate-950 shadow-lg shadow-black/20 sm:min-h-28"
    >
      <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/90 to-emerald-950/40" />
      {imageUrls.length > 0 ? (
        <div aria-hidden className="absolute inset-y-0 right-0 flex w-[46%] items-end justify-end gap-2 pr-3 sm:w-[40%] sm:pr-5">
          {imageUrls.slice(0, 3).map((url, index) => (
            <div
              key={`${url}-${index}`}
              className="relative h-20 w-16 overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-lg sm:h-24 sm:w-20"
              style={{ transform: `rotate(${index === 1 ? -6 : index === 2 ? 8 : 3}deg)` }}
            >
              <Image src={url} alt="" fill unoptimized className="object-cover" />
            </div>
          ))}
        </div>
      ) : (
        <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-900 to-emerald-900/40" />
      )}
      <div className="relative z-10 flex flex-1 items-center justify-between gap-3 p-4 sm:p-5">
        <div className="max-w-[58%] sm:max-w-none">
          <p className="text-base font-semibold text-white sm:text-lg">Conheça nossa loja oficial</p>
          <p className="mt-1 text-xs text-slate-300 sm:text-sm">Copos, produtos exclusivos e muito mais.</p>
        </div>
        <span className="inline-flex h-11 shrink-0 items-center gap-1 rounded-2xl border border-emerald-400/40 bg-emerald-500/15 px-3.5 text-sm font-semibold text-emerald-100">
          Acessar loja
          <ChevronRight size={16} />
        </span>
      </div>
    </Link>
  );
}
