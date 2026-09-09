import { Info } from 'lucide-react';
import { OKTOBERFEST_ACCESS_NOTICE } from '@/lib/public/oktoberfest-access-notice';
import { cx } from '@/components/militrin/utils';

type OktoberfestTicketNoticeProps = {
  variant?: 'default' | 'compact' | 'checkout';
  className?: string;
};

export function OktoberfestTicketNotice({ variant = 'default', className }: OktoberfestTicketNoticeProps) {
  const body =
    variant === 'checkout'
      ? OKTOBERFEST_ACCESS_NOTICE.full
      : variant === 'compact'
        ? OKTOBERFEST_ACCESS_NOTICE.short
        : OKTOBERFEST_ACCESS_NOTICE.short;

  return (
    <aside
      role="note"
      className={cx(
        'rounded-2xl border border-slate-600/50 bg-slate-900/70 text-slate-200',
        variant === 'checkout' ? 'p-4' : 'p-3',
        className,
      )}
    >
      <div className="flex gap-2.5">
        <Info
          size={variant === 'checkout' ? 18 : 16}
          strokeWidth={2}
          className="mt-0.5 shrink-0 text-sky-300"
          aria-hidden
        />
        <div className="min-w-0 space-y-1">
          <p className={cx(
            'font-semibold uppercase tracking-[0.14em] text-slate-100',
            variant === 'checkout' ? 'text-xs' : 'text-[10px]',
          )}
          >
            {OKTOBERFEST_ACCESS_NOTICE.title}
          </p>
          <p className={cx(variant === 'checkout' ? 'text-sm text-slate-300' : 'text-xs leading-relaxed text-slate-400')}>
            {body}
          </p>
        </div>
      </div>
    </aside>
  );
}
