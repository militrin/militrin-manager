import type { ReactNode } from 'react';
import { cx } from './utils';
import { militrinTokens } from './tokens';

type MilitrinPageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export function MilitrinPageHeader({ eyebrow, title, description, action, className }: MilitrinPageHeaderProps) {
  return (
    <header className={cx('flex flex-wrap items-start justify-between gap-4', className)}>
      <div>
        {eyebrow ? <p className={militrinTokens.eyebrow}>{eyebrow}</p> : null}
        <h1 className="mt-2 text-3xl font-semibold text-white">{title}</h1>
        {description ? <p className="mt-2 text-sm text-slate-300">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}
