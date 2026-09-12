import Link from 'next/link';
import { ChevronRight, ShoppingBag } from 'lucide-react';

export function HomeStoreBanner() {
  return (
    <Link
      href="/minha-conta/loja"
      className="flex items-center gap-3 rounded-2xl border border-slate-800/80 bg-slate-900/70 px-3 py-2.5 transition hover:border-slate-600"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-emerald-300">
        <ShoppingBag size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-white">Loja Militrin</span>
        <span className="block truncate text-xs text-slate-400">Copos e produtos exclusivos</span>
      </span>
      <span className="inline-flex h-11 shrink-0 items-center gap-1 rounded-2xl border border-slate-700 bg-slate-950/70 px-3 text-sm font-semibold text-slate-100">
        Ver loja
        <ChevronRight size={14} />
      </span>
    </Link>
  );
}
