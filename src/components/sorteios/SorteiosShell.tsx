import type { ReactNode } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { AdminPageHeader } from "@/components/admin";

export function SorteiosShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-3 py-4 text-slate-100 sm:px-5 lg:px-6">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4 lg:flex-row">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-4">
          <AdminPageHeader compact title={title} subtitle={subtitle} actions={actions} />
          {children}
        </div>
      </div>
    </main>
  );
}
