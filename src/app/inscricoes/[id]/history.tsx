"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatDateTimeBR } from "@/lib/utils/date";

export function ParticipantHistory({ participantId }: { participantId: string }) {
  const [items, setItems] = useState<Array<{ action: string; created_at: string; details?: Record<string, unknown> }>>([]);

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data, error } = await supabase.from("audit_logs").select("action, created_at, details").eq("entity_id", participantId).order("created_at", { ascending: false }).limit(6);
      if (!error) setItems((data ?? []) as Array<{ action: string; created_at: string; details?: Record<string, unknown> }>);
    }
    load();
  }, [participantId]);

  if (items.length === 0) return null;

  return (
    <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-sm font-semibold text-slate-200">Histórico básico</p>
      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <div key={`${item.action}-${item.created_at}`} className="flex items-center justify-between rounded-xl border border-slate-800/80 bg-slate-900/60 px-3 py-2 text-sm">
            <span className="text-slate-300">{item.action}</span>
            <span className="text-slate-400">{formatDateTimeBR(item.created_at, " às ")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
