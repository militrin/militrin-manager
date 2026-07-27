import { cx } from './utils';

type MilitrinProgressProps = {
  label: string;
  value: number;
  helper?: string;
  className?: string;
};

export function MilitrinProgress({ label, value, helper, className }: MilitrinProgressProps) {
  const normalized = Math.max(0, Math.min(100, value));
  return (
    <div className={cx('rounded-2xl border border-slate-800 bg-slate-950/60 p-4', className)}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{label}</p>
          {helper ? <p className="mt-2 text-sm text-slate-200">{helper}</p> : null}
        </div>
        <span className="rounded-full border border-emerald-500/40 px-3 py-1 text-xs uppercase tracking-wide text-emerald-200">{Math.round(normalized)}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full rounded-full bg-emerald-400" style={{ width: `${normalized}%` }} aria-label={`Progresso ${Math.round(normalized)}%`} />
      </div>
    </div>
  );
}
