"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export function ComparisonRowLabel({ label, rowKey }: { label:string; rowKey:string }) {
  const pathname=usePathname(); const router=useRouter(); const searchParams=useSearchParams(); const [pending,startTransition]=useTransition();
  function remove(){if(pending)return;const params=new URLSearchParams(searchParams.toString());const rows=params.getAll("compareRow");params.delete("compareRow");let removed=false;for(const row of rows){if(!removed&&row===rowKey){removed=true;continue;}params.append("compareRow",row);}startTransition(()=>router.replace(`${pathname}?${params.toString()}`,{scroll:false}));}
  return <div className="flex min-w-52 items-start justify-between gap-3"><span>{label}</span><button type="button" onClick={remove} disabled={pending} aria-label={`Excluir ${label} do comparativo`} className="rounded-md border border-rose-500/40 px-2 py-0.5 text-base leading-none text-rose-200 hover:bg-rose-500/10 disabled:opacity-50">×</button></div>;
}
