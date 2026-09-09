import type { ReactNode } from 'react';
import { ADMIN_TABLE_ZEBRA_CLASS } from './admin-table';
import { cx } from './utils';

type AdminDataTableProps = {
  children: ReactNode;
  className?: string;
};

export function AdminDataTable({ children, className }: AdminDataTableProps) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
      <table className={cx(ADMIN_TABLE_ZEBRA_CLASS, 'min-w-[1100px] w-full divide-y divide-slate-800 text-sm', className)}>
        {children}
      </table>
    </div>
  );
}
