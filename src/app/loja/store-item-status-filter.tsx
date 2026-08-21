"use client";

import { useRouter } from "next/navigation";

type StatusFilter = "active" | "inactive" | "all";

const OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "active", label: "Ativos" },
  { value: "inactive", label: "Desativados" },
  { value: "all", label: "Todos" },
];

export function StoreItemStatusFilter({ eventId, status }: { eventId: string | null; status: StatusFilter }) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-1 rounded-xl border border-slate-700 bg-slate-900 p-1 text-xs">
      {OPTIONS.map((option) => {
        const params = new URLSearchParams();
        if (eventId) params.set("eventId", eventId);
        if (option.value !== "active") params.set("status", option.value);
        const href = params.toString() ? `/loja?${params.toString()}` : "/loja";
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => router.push(href)}
            className={`rounded-lg px-2.5 py-1 ${status === option.value ? "bg-emerald-500/20 text-emerald-200" : "text-slate-400 hover:text-slate-200"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
