import type { ReactNode } from 'react';

type AdminDataTableProps = {
  children: ReactNode;
};

export function AdminDataTable({ children }: AdminDataTableProps) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
      <table className="min-w-[1100px] w-full divide-y divide-slate-800 text-sm">{children}</table>
    </div>
  );
}
