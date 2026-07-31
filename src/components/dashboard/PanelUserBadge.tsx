"use client";

import { useEffect, useState } from "react";
import { getTopbarIdentityAction } from "./topbar-actions";

type PanelIdentity = {
  initials: string;
  fullName: string;
  roleName: string;
};

const FALLBACK_IDENTITY: PanelIdentity = {
  initials: "--",
  fullName: "Usuário",
  roleName: "Sem função",
};

export function PanelUserBadge() {
  const [identity, setIdentity] = useState<PanelIdentity>(FALLBACK_IDENTITY);

  useEffect(() => {
    let mounted = true;
    getTopbarIdentityAction()
      .then((result) => {
        if (!mounted || !result.success) return;
        setIdentity(result.identity);
      })
      .catch(() => {
        if (!mounted) return;
        setIdentity(FALLBACK_IDENTITY);
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 px-3 py-2">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/20 font-semibold text-emerald-300">
        {identity.initials}
      </div>
      <div>
        <p className="text-sm font-semibold text-white">{identity.fullName}</p>
        <p className="text-xs text-slate-400">{identity.roleName}</p>
      </div>
    </div>
  );
}
