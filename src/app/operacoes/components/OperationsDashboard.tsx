"use client";

import type { ReactNode } from "react";

export function OperationsDashboard({
  message,
  children,
}: {
  message: string | null;
  children: ReactNode;
}) {
  return (
    <>
      {message ? (
        <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm">
          {message}
        </div>
      ) : null}

      <div className="mt-5 overflow-hidden rounded-2xl border border-slate-800">{children}</div>
    </>
  );
}
