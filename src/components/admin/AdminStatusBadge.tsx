import { cx } from './utils';

type AdminStatusBadgeProps = {
  status: string;
};

const map: Record<string, { label: string; className: string }> = {
  paid: { label: 'Pago', className: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' },
  confirmed: { label: 'Confirmado', className: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200' },
  pending: { label: 'Pendente', className: 'border-amber-500/40 bg-amber-500/15 text-amber-200' },
  cancelled: { label: 'Cancelado', className: 'border-rose-500/40 bg-rose-500/15 text-rose-200' },
  expired: { label: 'Expirado', className: 'border-slate-600 bg-slate-800/70 text-slate-200' },
  active: { label: 'Ativo', className: 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200' },
  used: { label: 'Utilizado', className: 'border-indigo-500/40 bg-indigo-500/15 text-indigo-200' },
  delivered: { label: 'Entregue', className: 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200' },
  reserved: { label: 'Reservado', className: 'border-slate-600 bg-slate-800/70 text-slate-200' },
};

export function AdminStatusBadge({ status }: AdminStatusBadgeProps) {
  const normalized = String(status || 'pending').toLowerCase();
  const item = map[normalized] ?? { label: status, className: 'border-slate-600 bg-slate-800/70 text-slate-200' };
  return <span className={cx('inline-flex rounded-full border px-2.5 py-1 text-xs font-medium', item.className)}>{item.label}</span>;
}
