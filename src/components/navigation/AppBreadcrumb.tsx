import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronRight, Home } from "lucide-react";
import { safeInternalHref, type BreadcrumbItem } from "@/lib/navigation/admin-navigation";

type Item = BreadcrumbItem & { icon?: ReactNode };

export function AppBreadcrumb({ items, backHref, fallbackHref = "/painel" }: { items: Item[]; backHref?: string; fallbackHref?: string }) {
  const normalized = items.filter((item) => item.label.trim());
  const safeBackHref = safeInternalHref(backHref, fallbackHref);
  return <div className="flex min-w-0 items-center gap-3">
    <Link href={safeBackHref} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-800 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-emerald-500/50 hover:text-emerald-200" aria-label="Voltar ao contexto anterior">
      <ArrowLeft size={14}/> Voltar
    </Link>
    <nav aria-label="Breadcrumb" className="min-w-0 overflow-x-auto [scrollbar-width:none]">
      <ol className="flex min-w-max items-center gap-1.5 whitespace-nowrap text-xs text-slate-400 sm:text-sm">
        {normalized.map((item,index) => {
          const current=index===normalized.length-1;
          return <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index ? <ChevronRight size={13} className="shrink-0 text-slate-600" aria-hidden/> : null}
            {current || !item.href ? <span aria-current={current ? "page" : undefined} className={current ? "max-w-48 truncate font-medium text-slate-200 sm:max-w-72" : "max-w-40 truncate"}>{item.icon}{item.label}</span> : <Link href={safeInternalHref(item.href,"/painel")} className="inline-flex max-w-40 items-center gap-1 truncate hover:text-emerald-200 sm:max-w-64">{item.icon ?? (index===0 ? <Home size={13} aria-hidden/> : null)}<span className="truncate">{item.label}</span></Link>}
          </li>;
        })}
      </ol>
    </nav>
  </div>;
}
